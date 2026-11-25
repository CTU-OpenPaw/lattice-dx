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
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('rich-schema module exists and contains zero eval, new Function, or node:vm', () => {
  const rsPath = path.join(PLUGIN_ROOT, 'src/server/rich-schema.js');
  assert.equal(fs.existsSync(rsPath), true, 'src/server/rich-schema.js must exist');
  const src = fs.readFileSync(rsPath, 'utf8');
  assert.equal(/\beval\s*\(/.test(src), false, 'Must not contain eval(');
  assert.equal(/\bnew\s+Function\b/.test(src), false, 'Must not contain new Function');
  assert.equal(/require\s*\(\s*['"](?:node:)?vm['"]\s*\)/.test(src), false, 'Must not import vm');
});

test('Formula AST parser & evaluator supports arithmetic, comparisons, logical/ternary short-circuit, and all 22 whitelisted functions', () => {
  const {
    parseFormulaAst,
    evaluateFormulaExpression,
    validateFormulaExpression,
  } = require('../src/server/rich-schema');

  // Precedence & unary
  assert.equal(evaluateFormulaExpression('2 + 3 * 4 - -1'), 15);
  assert.equal(evaluateFormulaExpression('(2 + 3) * (4 % 3)'), 5);
  assert.equal(evaluateFormulaExpression('!(qty > 10)', { qty: 5 }), true);

  // Comparisons, logical short-circuit, ternary short-circuit
  assert.equal(evaluateFormulaExpression('price >= 100 && qty === 2', { price: 100, qty: 2 }), true);
  assert.equal(evaluateFormulaExpression('qty == 0 || (total / qty) > 5', { qty: 0, total: 10 }), true);
  assert.equal(evaluateFormulaExpression('qty > 0 ? total / qty : 0', { qty: 0, total: 100 }), 0);
  assert.equal(evaluateFormulaExpression('IF(qty > 0, total / qty, -1)', { qty: 0, total: 100 }), -1);

  // Math functions
  assert.equal(evaluateFormulaExpression('ROUND(3.14159, 2)'), 3.14);
  assert.equal(evaluateFormulaExpression('ABS(-42)'), 42);
  assert.equal(evaluateFormulaExpression('CEIL(2.1)'), 3);
  assert.equal(evaluateFormulaExpression('FLOOR(2.9)'), 2);
  assert.equal(evaluateFormulaExpression('MIN(10, 3, 7)'), 3);
  assert.equal(evaluateFormulaExpression('MAX(10, 3, 7)'), 10);
  assert.equal(evaluateFormulaExpression('POW(2, 5)'), 32);
  assert.equal(evaluateFormulaExpression('SQRT(81)'), 9);

  // Null/logic/string functions
  assert.equal(evaluateFormulaExpression('COALESCE(a, b, "fallback")', { a: null, b: 'ok' }), 'ok');
  assert.equal(evaluateFormulaExpression('ISNULL(missing)', {}), true);
  assert.equal(evaluateFormulaExpression('ISNULL(0)', {}), false);
  assert.equal(evaluateFormulaExpression('CONCAT(UPPER(TRIM("  ab ")), "-", LOWER("CD"))'), 'AB-cd');
  assert.equal(evaluateFormulaExpression('LEN("hello")'), 5);
  assert.equal(evaluateFormulaExpression('SUBSTR("abcdef", 1, 3)'), 'bcd');

  // Date functions
  const nowStr = evaluateFormulaExpression('NOW()');
  assert.ok(typeof nowStr === 'string' && !Number.isNaN(Date.parse(nowStr)));
  assert.equal(evaluateFormulaExpression('YEAR("2026-11-25T10:00:00Z")'), 2026);
  assert.equal(evaluateFormulaExpression('MONTH("2026-11-25T10:00:00Z")'), 11);
  assert.equal(evaluateFormulaExpression('DAY("2026-11-25T10:00:00Z")'), 25);
  assert.equal(evaluateFormulaExpression('DATEDIFF_DAYS("2026-11-25T00:00:00Z", "2026-11-20T00:00:00Z")'), 5);

  // AST & validation metadata
  const ast = parseFormulaAst('qty * unitPrice');
  assert.equal(ast.type, 'Program');
  assert.deepEqual(ast.referencedFields, ['qty', 'unitPrice']);
  const v = validateFormulaExpression('qty * unitPrice', { selfFieldName: 'lineTotal', knownFields: ['qty', 'unitPrice'] });
  assert.equal(v.valid, true);
});

test('Formula AST engine rejects prototype pollution, blocked globals, unknown functions, self-reference, excessive depth/length, and syntax errors', () => {
  const { validateFormulaExpression, evaluateFormulaExpression } = require('../src/server/rich-schema');

  const blockedCases = [
    '__proto__.polluted',
    'constructor.constructor("return process")()',
    'prototype',
    'process.exit(1)',
    'globalThis.fetch',
    'require("fs")',
    'Function("return 1")()',
    'eval("1+1")',
    'UNKNOWN_FN(1)',
    '"unclosed',
    '(1 + 2',
    '1 + ; 2',
  ];
  for (const expr of blockedCases) {
    const res = validateFormulaExpression(expr);
    assert.equal(res.valid, false, `Expected invalid formula for: ${expr}`);
  }

  // Self-reference
  const selfRef = validateFormulaExpression('lineTotal + 1', { selfFieldName: 'lineTotal' });
  assert.equal(selfRef.valid, false);

  // Length > 1000
  assert.equal(validateFormulaExpression('1' + ' + 1'.repeat(400)).valid, false);

  // Depth > 24
  const deepExpr = '('.repeat(30) + '1' + ')'.repeat(30);
  assert.equal(validateFormulaExpression(deepExpr).valid, false);

  // Safe object prototype lookup must never leak Object.prototype properties
  assert.equal(evaluateFormulaExpression('toString', { a: 1 }), undefined);
});

test('ReDoS guard & validateRecordFields enforce required, min, max, pattern, enum, and org-scoped unique', async () => {
  const { validateSafeRegexPattern, validateRecordFields } = require('../src/server/rich-schema');

  assert.equal(validateSafeRegexPattern('^[A-Z]{2}-\\d{4}$').valid, true);
  for (const badPattern of ['(a+)+', '(.*)*', '(a|aa)+', '(a)\\1', '(?<=a)b', 'a{500,}', 'a'.repeat(260), '[unclosed']) {
    const res = validateSafeRegexPattern(badPattern);
    assert.equal(res.valid, false, `Expected ReDoS/invalid pattern rejection for: ${badPattern}`);
  }

  const rows = [
    { id: 1, organizationId: 'org-a', code: 'AB-1001', qty: 5, status: 'open' },
    { id: 2, organizationId: 'org-b', code: 'AB-2002', qty: 10, status: 'open' },
  ];
  const fakeDb = {
    getRepository: () => ({
      async find({ filter = {} } = {}) {
        return rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
      },
    }),
  };
  const fields = [
    {
      name: 'code',
      type: 'string',
      validation: { required: true, unique: true, min: 3, max: 12, pattern: '^[A-Z]{2}-\\d{4}$' },
    },
    {
      name: 'qty',
      type: 'integer',
      validation: { required: true, min: 0, max: 100 },
    },
    {
      name: 'status',
      type: 'string',
      validation: { enum: ['open', 'closed'] },
    },
  ];

  // Valid new record in org-b with code existing in org-a (org-scoped unique allows!)
  await validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
    organizationId: 'org-b',
    code: 'AB-1001',
    qty: 0,
    status: 'open',
  });

  // Update existing record id=1 with same code in org-a (self excluded!)
  await validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
    id: 1,
    organizationId: 'org-a',
    code: 'AB-1001',
    qty: 5,
    status: 'closed',
  });

  // Duplicate in same org-a -> 409 VALIDATION_UNIQUE_CONFLICT
  await assert.rejects(
    () => validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
      organizationId: 'org-a',
      code: 'AB-1001',
      qty: 5,
      status: 'open',
    }),
    (err) => err.status === 409 && err.code === 'VALIDATION_UNIQUE_CONFLICT',
  );

  // Required fails on empty string/null but 0 is allowed above
  await assert.rejects(
    () => validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
      organizationId: 'org-a',
      code: '',
      qty: 5,
    }),
    (err) => err.status === 400 && err.code === 'VALIDATION_REQUIRED',
  );

  // Min/Max numeric & string length
  await assert.rejects(
    () => validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
      organizationId: 'org-a',
      code: 'AB-9999',
      qty: 101,
    }),
    (err) => err.status === 400 && err.code === 'VALIDATION_MAX',
  );

  // Pattern mismatch
  await assert.rejects(
    () => validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
      organizationId: 'org-a',
      code: 'bad-code',
      qty: 5,
    }),
    (err) => err.status === 400 && err.code === 'VALIDATION_PATTERN',
  );

  // Enum mismatch
  await assert.rejects(
    () => validateRecordFields(fakeDb, 'latticeCustomOrders', fields, {
      organizationId: 'org-a',
      code: 'AB-9999',
      qty: 5,
      status: 'invalid',
    }),
    (err) => err.status === 400 && err.code === 'VALIDATION_ENUM',
  );
});

test('belongsToMany join collection naming satisfies both CUSTOM_COLLECTION_RE and CUSTOM_RLS_TABLE_RE, and domain-builder handles hasOne, belongsToMany, formula, validation', async () => {
  const {
    ALLOWED_FIELD_TYPES,
    buildSafeJoinCollectionName,
    createOrUpdateDomainCollection,
    sanitizeFields,
  } = require('../src/server/domain-builder');

  assert.equal(ALLOWED_FIELD_TYPES.size, 12);
  for (const t of ['string', 'text', 'integer', 'float', 'boolean', 'date', 'datetime', 'json', 'belongsTo', 'hasOne', 'belongsToMany', 'formula']) {
    assert.equal(ALLOWED_FIELD_TYPES.has(t), true, `Missing type ${t}`);
  }

  const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
  const CUSTOM_RLS_TABLE_RE = /^latticeCustom[A-Za-z0-9_]*$/;
  const joinShort = buildSafeJoinCollectionName('latticeCustomInspections', 'tags', 'latticeCustomTags');
  const joinLong = buildSafeJoinCollectionName(
    'latticeCustomVeryLongEnterpriseColdChainInspectionRecord',
    'complianceStandards',
    'latticeCustomInternationalQualityComplianceStandardItems',
  );
  for (const name of [joinShort, joinLong]) {
    assert.match(name, CUSTOM_COLLECTION_RE);
    assert.match(name, CUSTOM_RLS_TABLE_RE);
    assert.ok(name.length <= 54);
  }

  // Invalid hasOne target & invalid belongsToMany keys
  assert.throws(
    () => sanitizeFields([{ name: 'ownerProfile', type: 'hasOne', target: 'users' }]),
    (err) => err.status === 400 && err.code === 'INVALID_HAS_ONE_TARGET',
  );
  assert.throws(
    () => sanitizeFields([{ name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags', through: 'users' }]),
    (err) => err.status === 400 && err.code === 'INVALID_THROUGH_COLLECTION',
  );
  assert.throws(
    () => sanitizeFields([{ name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags', foreignKey: 'sameId', otherKey: 'sameId' }]),
    (err) => err.status === 400,
  );

  // Mock Postgres DB verifying expectedColumns skips hasOne & belongsToMany while keeping formula
  const store = { collections: [], fields: [], dataSourcesRoles: [], dataSourcesRolesResources: [], dataSourcesRolesResourcesActions: [] };
  const seq = { collections: 1, fields: 1, dataSourcesRoles: 1, dataSourcesRolesResources: 1, dataSourcesRolesResourcesActions: 1 };
  const rlsAttached = [];
  const syncCalls = [];
  const queries = [];
  const collectionsMap = new Map();

  const db = {
    store,
    getRepository(name) {
      if (!store[name]) { store[name] = []; seq[name] = 1; }
      return {
        async find({ filter = {} } = {}) {
          return store[name].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        },
        async findOne({ filter = {} } = {}) {
          return store[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) || null;
        },
        async count() { return store[name].length; },
        async create({ values }) {
          const row = { id: seq[name]++, ...structuredClone(values) };
          store[name].push(row);
          return { ...row };
        },
        async update({ filter = {}, filterByTk, values }) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          for (const row of store[name]) {
            if (Object.entries(eff).every(([k, v]) => row[k] === v)) Object.assign(row, structuredClone(values));
          }
          return [1];
        },
      };
    },
    collection(def) {
      collectionsMap.set(def.name, def);
      return {
        ...def,
        async sync(opts) { syncCalls.push({ name: def.name, opts }); },
      };
    },
    getCollection(name) { return collectionsMap.get(name) || null; },
    async attachLatticeRlsPolicy(tableName) { rlsAttached.push(tableName); },
    sequelize: {
      getDialect: () => 'postgres',
      async query(sql, opts) {
        queries.push(String(sql));
        const table = opts?.replacements?.tableName;
        if (String(sql).includes('information_schema.columns')) {
          if (table === 'latticeCustomQuotes') {
            return [[
              { column_name: 'organizationId' },
              { column_name: 'qty' },
              { column_name: 'unitPrice' },
              { column_name: 'totalAmount' },
            ], []];
          }
          return [[], []];
        }
        if (String(sql).includes('FROM pg_class')) {
          return [[{ rls_enabled: true, rls_forced: true }], []];
        }
        return [[], []];
      },
    },
  };

  const result = await createOrUpdateDomainCollection(db, {
    collectionName: 'latticeCustomQuotes',
    title: 'Quotes',
    fields: [
      { name: 'qty', type: 'integer', validation: { required: true, min: 1 } },
      { name: 'unitPrice', type: 'float', validation: { required: true, min: 0 } },
      { name: 'totalAmount', type: 'formula', formulaExpression: 'qty * unitPrice', formulaReturnType: 'float' },
      { name: 'approvalNote', type: 'hasOne', target: 'latticeCustomNotes', foreignKey: 'quoteId' },
      { name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags', through: 'latticeCustomQuoteTags', foreignKey: 'quoteId', otherKey: 'tagId' },
    ],
  });

  // Main table already has organizationId, qty, unitPrice, totalAmount -> MUST NOT drop RLS policy or alter!
  assert.equal(queries.some((q) => q.includes('DROP POLICY') && q.includes('latticeCustomQuotes')), false);
  const quoteSync = syncCalls.find((s) => s.name === 'latticeCustomQuotes');
  assert.equal(quoteSync.opts?.alter, undefined);

  // Join collection provisioned with organizationId, foreignKey, otherKey, indexes <= 63 chars, and RLS
  assert.ok(rlsAttached.includes('latticeCustomQuoteTags'));
  const joinColDef = collectionsMap.get('latticeCustomQuoteTags');
  assert.ok(joinColDef);
  assert.ok(joinColDef.fields.some((f) => f.name === 'organizationId' && f.allowNull === false && f.index === true));
  assert.ok(joinColDef.fields.some((f) => f.name === 'quoteId' && f.index === true));
  assert.ok(joinColDef.fields.some((f) => f.name === 'tagId' && f.index === true));
  for (const idx of joinColDef.indexes || []) {
    assert.ok(idx.name.length <= 63);
  }
  assert.ok(Array.isArray(result.joinCollections) && result.joinCollections.some((j) => j.collectionName === 'latticeCustomQuoteTags'));
});

test('DxosStudioPlugin wires registerRichSchemaHooks on load, runs beforeValidate + beforeSave hooks, and cleans up on unload', async () => {
  const origLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: class {}, Migration: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  let DxosStudioPlugin;
  try {
    DxosStudioPlugin = require('../src/server');
  } finally {
    Module._load = origLoad;
  }

  assert.equal(typeof DxosStudioPlugin.parseFormulaAst, 'function');
  assert.equal(typeof DxosStudioPlugin.evaluateFormulaExpression, 'function');
  assert.equal(typeof DxosStudioPlugin.validateFormulaExpression, 'function');

  const emitter = new EventEmitter();
  const fieldRows = [
    {
      collectionName: 'latticeCustomInvoices',
      name: 'code',
      type: 'string',
      options: { validation: { required: true, pattern: '^INV-[0-9]+$' } },
    },
    {
      collectionName: 'latticeCustomInvoices',
      name: 'qty',
      type: 'integer',
      options: { validation: { min: 1 } },
    },
    {
      collectionName: 'latticeCustomInvoices',
      name: 'price',
      type: 'float',
    },
    {
      collectionName: 'latticeCustomInvoices',
      name: 'subtotal',
      type: 'formula',
      options: { formula: 'qty * price', formulaReturnType: 'float' },
    },
  ];
  const fakeDb = {
    collections: new Map([['latticeCustomInvoices', { name: 'latticeCustomInvoices', fields: new Map() }]]),
    on(evt, fn) { emitter.on(evt, fn); },
    off(evt, fn) { emitter.off(evt, fn); },
    removeListener(evt, fn) { emitter.removeListener(evt, fn); },
    async emitAsync(evt, ...args) {
      for (const fn of emitter.listeners(evt)) await fn(...args);
    },
    getRepository(name) {
      if (name === 'fields') {
        return {
          async find({ filter = {} } = {}) {
            return fieldRows.filter((r) => !filter.collectionName || r.collectionName === filter.collectionName);
          },
        };
      }
      return null;
    },
  };
  const fakeApp = {
    resourceManager: { use() {}, define() {} },
    acl: { registerSnippet() {}, allow() {} },
  };

  const prevTick = process.env.DX_FLOW_DELAY_TICK_MS;
  process.env.DX_FLOW_DELAY_TICK_MS = '0';
  const plugin = new DxosStudioPlugin();
  plugin.db = fakeDb;
  plugin.app = fakeApp;
  try {
    await plugin.load();

    // Invalid code fails beforeValidate
    const badModel = {
      dataValues: { organizationId: 'org-a', code: 'BAD', qty: 2, price: 50 },
      get(k) { return this.dataValues[k]; },
      set(k, v) { this.dataValues[k] = v; },
    };
    await assert.rejects(
      () => fakeDb.emitAsync('latticeCustomInvoices.beforeValidate', badModel, { fields: ['code', 'qty', 'price'] }),
      (err) => err.status === 400 && err.code === 'VALIDATION_PATTERN',
    );

    // Valid record computes formula in beforeSave and appends to options.fields
    const goodModel = {
      dataValues: { organizationId: 'org-a', code: 'INV-100', qty: 3, price: 25.5 },
      get(k) { return this.dataValues[k]; },
      set(k, v) { this.dataValues[k] = v; },
    };
    const saveOpts = { fields: ['code', 'qty', 'price'] };
    await fakeDb.emitAsync('latticeCustomInvoices.beforeValidate', goodModel, saveOpts);
    await fakeDb.emitAsync('latticeCustomInvoices.beforeSave', goodModel, saveOpts);
    assert.equal(goodModel.get('subtotal'), 76.5);
    assert.ok(saveOpts.fields.includes('subtotal'));

    await plugin.unload();
    assert.equal(emitter.listenerCount('latticeCustomInvoices.beforeValidate'), 0);
    assert.equal(emitter.listenerCount('latticeCustomInvoices.beforeSave'), 0);
  } finally {
    if (prevTick === undefined) delete process.env.DX_FLOW_DELAY_TICK_MS;
    else process.env.DX_FLOW_DELAY_TICK_MS = prevTick;
  }
});

test('portal-composer validates ALLOWED_DXOS_BLOCK_USES and includes DxosBiChartBlockModel in OVERVIEW_SPECS', async () => {
  const {
    ALLOWED_DXOS_BLOCK_USES,
    OVERVIEW_SPECS,
    attachDxosBlocksToTab,
  } = require('../src/server/portal-composer');

  assert.ok(ALLOWED_DXOS_BLOCK_USES instanceof Set);
  assert.equal(ALLOWED_DXOS_BLOCK_USES.has('DxosBiChartBlockModel'), true);
  assert.equal(ALLOWED_DXOS_BLOCK_USES.size, 12);

  const biBlocks = OVERVIEW_SPECS.flatMap((s) => s.blocks || []).filter((b) => b.use === 'DxosBiChartBlockModel');
  assert.ok(biBlocks.length >= 2, 'Expected DxosBiChartBlockModel in procurement and logistics OVERVIEW_SPECS');
  const logisticsSpec = OVERVIEW_SPECS.find((s) => s.slug === 'logistics');
  const logisticsBi = (logisticsSpec?.blocks || []).find((b) => b.use === 'DxosBiChartBlockModel');
  assert.ok(logisticsBi, 'Expected Logistics portal OVERVIEW_SPECS to seed DxosBiChartBlockModel');
  assert.equal(logisticsBi.config.collection, 'latticeOrders');
  assert.equal(logisticsBi.config.groupBy, 'status');
  assert.equal(logisticsBi.config.chartType, 'bar');

  await assert.rejects(
    () => attachDxosBlocksToTab({
      getRepository: () => ({
        findModelByParentId: async () => ({ uid: 'grid-1', props: {}, stepParams: {} }),
        upsertModel: async () => {},
      }),
    }, 'tab-1', 'procurement', [{ uidSuffix: 'evil', use: 'EvilBlockModel', config: {} }]),
    (err) => err.status === 400 && err.code === 'DISALLOWED_BLOCK_USE',
  );
});

test('solution-bundle v3 supports DxosBiChartBlockModel and full Rich Schema round-trip, validation, join table auto-provision, and field update on rollback', async () => {
  const {
    ALLOWED_FLOW_MODEL_USES,
    exportSolutionBundle,
    validateSolutionBundle,
    diffSolutionBundle,
    importSolutionBundle,
    rollbackLastSolutionBundle,
  } = require('../src/server/solution-bundle');

  assert.equal(ALLOWED_FLOW_MODEL_USES.has('DxosBiChartBlockModel'), true);

  const customCollections = [
    {
      id: 1,
      name: 'latticeCustomInvoices',
      title: 'Invoices',
      options: { titleField: 'code', uiManageable: true },
      fields: [
        { name: 'organizationId', type: 'string', allowNull: false, defaultValue: 'org-a' },
        { name: 'code', type: 'string', validation: { required: true, unique: true, pattern: '^INV-\\d+$' } },
        { name: 'qty', type: 'integer', validation: { min: 1, max: 500 } },
        { name: 'unitPrice', type: 'float' },
        { name: 'lineTotal', type: 'formula', formulaExpression: 'qty * unitPrice', formulaReturnType: 'float' },
        { name: 'asset', type: 'belongsTo', target: 'latticeAssets', foreignKey: 'assetId' },
        { name: 'note', type: 'hasOne', target: 'latticeCustomInvoiceNotes', foreignKey: 'invoiceId' },
        { name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags', through: 'latticeCustomInvoiceTags', foreignKey: 'invoiceId', otherKey: 'tagId' },
      ],
    },
  ];
  const snapshots = [];
  const rlsAttached = [];
  const synced = [];
  const repos = {
    roles: [{ name: 'ldx_operator', title: 'Operator', snippets: ['!pm'] }],
    dataSourcesRolesResources: [],
    dataSourcesRolesResourcesActions: [],
    uiLayouts: [],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [
      {
        uid: 'dxos-ov-procurement-bi-chart',
        use: 'DxosBiChartBlockModel',
        parentId: 'grid_1',
        subKey: 'items',
        subType: 'array',
        props: { title: 'BI Chart', collection: 'latticeRequests', chartType: 'bar', groupBy: 'status', metric: { op: 'count' }, limit: 100 },
        stepParams: { dxosBlockSettings: { config: { chartType: 'bar', groupBy: 'status' } } },
      },
    ],
    collections: customCollections,
    latticeOrganizations: [{ organizationId: 'org-a', active: true }],
    latticeUiSnapshots: snapshots,
  };
  let seq = 100;
  const db = {
    sequelize: { transaction: async (fn) => fn({ id: 'tx-1' }) },
    hasCollection: (n) => Object.hasOwn(repos, n),
    getCollection: (n) => ({
      name: n,
      sync: async () => { synced.push(n); },
    }),
    attachLatticeRlsPolicy: async (n) => { rlsAttached.push(n); },
    getRepository(name) {
      if (!Object.hasOwn(repos, name)) return null;
      return {
        find: async ({ filter = {} } = {}) => repos[name].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).map((r) => structuredClone(r)),
        findOne: async ({ filter = {} } = {}) => {
          const hit = repos[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          return hit ? structuredClone(hit) : null;
        },
        create: async ({ values }) => {
          const row = { id: ++seq, ...structuredClone(values) };
          repos[name].push(row);
          return structuredClone(row);
        },
        update: async ({ filter = {}, filterByTk, values }) => {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          for (const row of repos[name]) {
            if (Object.entries(eff).every(([k, v]) => row[k] === v)) Object.assign(row, structuredClone(values));
          }
          return [1];
        },
      };
    },
  };

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(validateSolutionBundle(exported).valid, true);
  assert.equal(exported.routesAndBlocks.flowModels[0].use, 'DxosBiChartBlockModel');

  // Validation rejections for unsafe rich-schema fields
  const badFormula = structuredClone(exported);
  badFormula.customCollections[0].fields.find((f) => f.name === 'lineTotal').formulaExpression = '__proto__.x';
  assert.equal(validateSolutionBundle(badFormula).valid, false);

  const badRedos = structuredClone(exported);
  badRedos.customCollections[0].fields.find((f) => f.name === 'code').validation.pattern = '(a+)+$';
  assert.equal(validateSolutionBundle(badRedos).valid, false);

  const badTarget = structuredClone(exported);
  badTarget.customCollections[0].fields.find((f) => f.name === 'note').target = 'users';
  assert.equal(validateSolutionBundle(badTarget).valid, false);

  // Diff detects formulaExpression & validation changes
  const incoming = structuredClone(exported);
  incoming.customCollections[0].fields.find((f) => f.name === 'qty').validation.max = 999;
  incoming.customCollections[0].fields.find((f) => f.name === 'lineTotal').formulaExpression = 'qty * unitPrice * 1.1';
  const diff = diffSolutionBundle(exported, incoming);
  assert.deepEqual(diff.sections.customCollections.changed, ['latticeCustomInvoices']);

  // Import updates existing fields AND auto-provisions missing belongsToMany join collection + RLS
  await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  const updatedQty = customCollections.find((c) => c.name === 'latticeCustomInvoices').fields.find((f) => f.name === 'qty');
  assert.equal(updatedQty.validation.max, 999);
  const joinCol = customCollections.find((c) => c.name === 'latticeCustomInvoiceTags');
  assert.ok(joinCol, 'belongsToMany through join collection must be auto-provisioned');
  assert.ok(joinCol.fields.some((f) => f.name === 'organizationId' && f.allowNull === false));
  assert.ok(rlsAttached.includes('latticeCustomInvoiceTags'));

  // Rollback restores prior validation.max and formulaExpression
  await rollbackLastSolutionBundle(db, { organizationId: 'org-a' });
  const restoredCol = customCollections.find((c) => c.name === 'latticeCustomInvoices');
  assert.equal(restoredCol.fields.find((f) => f.name === 'qty').validation.max, 500);
  assert.equal(restoredCol.fields.find((f) => f.name === 'lineTotal').formulaExpression, 'qty * unitPrice');

  // XSS inside DxosBiChartBlockModel.props and customCollections is rejected
  const xssChart = structuredClone(exported);
  xssChart.routesAndBlocks.flowModels[0].props.title = '<script>alert(1)</script>';
  assert.equal(validateSolutionBundle(xssChart).valid, false);

  const xssCol = structuredClone(exported);
  xssCol.customCollections[0].title = '<img src=x onerror=alert(1)>';
  assert.equal(validateSolutionBundle(xssCol).valid, false);
});

test('applyCustomCollectionsSection updates existing fields via fieldsRepo.update when fields repo exists, and all rich-schema exports & SPDX headers are present', async () => {
  const { applyCustomCollectionsSection } = (() => {
    const sb = require('../src/server/solution-bundle');
    return {
      applyCustomCollectionsSection: async (db, cols, orgId) => {
        const res = await sb.importSolutionBundle(db, {
          metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: orgId },
          customCollections: cols,
        }, { dryRun: false, organizationId: orgId });
        return res;
      },
    };
  })();
  const domainBuilder = require('../src/server/domain-builder');
  for (const sym of [
    'ALLOWED_FIELD_TYPES',
    'parseFormulaAst',
    'evaluateFormulaExpression',
    'validateFormulaExpression',
    'validateSafeRegexPattern',
    'buildSafeJoinCollectionName',
    'registerRichSchemaHooks',
    'attachRichSchemaHooksForCollection',
    'validateRecordFields',
    'applyFormulaFields',
  ]) {
    assert.ok(domainBuilder[sym] !== undefined, `domain-builder must re-export ${sym}`);
  }

  const collections = [
    { id: 1, name: 'latticeCustomItems', title: 'Items', options: { titleField: 'code' } },
  ];
  const fields = [
    { id: 10, collectionName: 'latticeCustomItems', name: 'organizationId', type: 'string', allowNull: false, defaultValue: 'org-a' },
    { id: 11, collectionName: 'latticeCustomItems', name: 'qty', type: 'integer', validation: { min: 1, max: 10 } },
  ];
  let updatedCalls = 0;
  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    hasCollection: () => true,
    getCollection: () => ({ sync: async () => {} }),
    attachLatticeRlsPolicy: async () => {},
    getRepository(name) {
      if (name === 'collections') {
        return {
          find: async () => collections,
          findOne: async ({ filter }) => {
            const c = collections.find((r) => r.name === filter?.name);
            return c ? { ...c, fields: fields.filter((f) => f.collectionName === c.name) } : null;
          },
          update: async () => [1],
        };
      }
      if (name === 'fields') {
        return {
          create: async ({ values }) => {
            const row = { id: fields.length + 1, ...structuredClone(values) };
            fields.push(row);
            return row;
          },
          update: async ({ filter, values }) => {
            updatedCalls += 1;
            const row = fields.find((f) => f.collectionName === filter.collectionName && f.name === filter.name);
            if (row) Object.assign(row, structuredClone(values));
            return [1];
          },
        };
      }
      if (name === 'latticeUiSnapshots') {
        return { find: async () => [], create: async ({ values }) => values };
      }
      return { find: async () => [], findOne: async () => null };
    },
  };

  await applyCustomCollectionsSection(db, [
    {
      name: 'latticeCustomItems',
      title: 'Items',
      fields: [
        { name: 'qty', type: 'integer', validation: { min: 1, max: 250 } },
        { name: 'score', type: 'formula', formulaExpression: 'qty * 2' },
      ],
    },
  ], 'org-a');

  assert.equal(updatedCalls, 1);
  assert.equal(fields.find((f) => f.name === 'qty').validation.max, 250);
  assert.equal(fields.find((f) => f.name === 'score').formulaExpression, 'qty * 2');
});

test('Regression (M1.2 R2 F1): validateSafeRegexPattern rejects shorthand-class and nullable-prefix ReDoS patterns while allowing valid patterns', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const t0 = performance.now();
  const redosPatterns = [
    '(\\w|a)+$',
    '(\\d|\\w)+$',
    '(a|\\w)+$',
    '(\\s|\\S)+$',
    '(\\D|a)+$',
    '(\\p{L}|a)+$',
    '(a?b|b)+',
    '(a?|b)+',
    '((a|b)?c|b)+',
  ];
  for (const pat of redosPatterns) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected ReDoS rejection for: ${pat}`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `ReDoS validation took too long: ${elapsedMs}ms`);

  for (const okPat of ['^[A-Z]{2}-\\d{4}$', '^[A-Z0-9-]+$', '^INV-\\d+$', '^(?:INV|PO)+$', '(\\w|\\d)']) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected valid pattern to pass: ${okPat} (${res.error || ''})`);
  }
});

test('Regression (M1.2 R2 F4): beforeSave validates min/max/pattern/enum on computed formula fields after formula evaluation', async () => {
  const { attachRichSchemaHooksForCollection } = require('../src/server/rich-schema');
  const emitter = new EventEmitter();
  const db = {
    on(evt, fn) { emitter.on(evt, fn); },
    off(evt, fn) { emitter.off(evt, fn); },
    async emitAsync(evt, ...args) {
      for (const fn of emitter.listeners(evt)) await fn(...args);
    },
  };
  const fields = [
    { name: 'price', type: 'float' },
    { name: 'qty', type: 'integer' },
    {
      name: 'total',
      type: 'formula',
      formulaExpression: 'price * qty',
      formulaReturnType: 'float',
      validation: { min: 10, max: 100 },
    },
    {
      name: 'label',
      type: 'formula',
      formulaExpression: 'CONCAT("T-", qty)',
      formulaReturnType: 'string',
      validation: { min: 4, pattern: '^T-[0-9]+$' },
    },
  ];
  attachRichSchemaHooksForCollection(db, 'latticeCustomFormulaChecks', fields);

  const makeModel = (data) => ({
    dataValues: { organizationId: 'org-a', ...data },
    get(k) { return this.dataValues[k]; },
    set(k, v) { this.dataValues[k] = v; },
  });

  // 30 * 5 = 150 > max 100 -> VALIDATION_MAX
  const overMax = makeModel({ price: 30, qty: 5 });
  await db.emitAsync('latticeCustomFormulaChecks.beforeValidate', overMax, { fields: ['price', 'qty'] });
  await assert.rejects(
    () => db.emitAsync('latticeCustomFormulaChecks.beforeSave', overMax, { fields: ['price', 'qty'] }),
    (err) => err.status === 400 && err.code === 'VALIDATION_MAX',
  );

  // 1 * 5 = 5 < min 10 -> VALIDATION_MIN
  const underMin = makeModel({ price: 1, qty: 5 });
  await db.emitAsync('latticeCustomFormulaChecks.beforeValidate', underMin, { fields: ['price', 'qty'] });
  await assert.rejects(
    () => db.emitAsync('latticeCustomFormulaChecks.beforeSave', underMin, { fields: ['price', 'qty'] }),
    (err) => err.status === 400 && err.code === 'VALIDATION_MIN',
  );

  // total = 50 (ok), label = "T-5" (len 3 < min 4) -> VALIDATION_MIN
  const shortLabel = makeModel({ price: 10, qty: 5 });
  await db.emitAsync('latticeCustomFormulaChecks.beforeValidate', shortLabel, { fields: ['price', 'qty'] });
  await assert.rejects(
    () => db.emitAsync('latticeCustomFormulaChecks.beforeSave', shortLabel, { fields: ['price', 'qty'] }),
    (err) => err.status === 400 && err.code === 'VALIDATION_MIN',
  );

  // total = 50, label = "T-10" -> passes
  const validModel = makeModel({ price: 5, qty: 10 });
  await db.emitAsync('latticeCustomFormulaChecks.beforeValidate', validModel, { fields: ['price', 'qty'] });
  await db.emitAsync('latticeCustomFormulaChecks.beforeSave', validModel, { fields: ['price', 'qty'] });
  assert.equal(validModel.get('total'), 50);
  assert.equal(validModel.get('label'), 'T-10');
});

test('Regression (M1.2 R2 F3-domain): domain-builder provisions, syncs, and RLS-protects belongsToMany through join collection BEFORE syncing main collection', async () => {
  const { createOrUpdateDomainCollection } = require('../src/server/domain-builder');
  const store = { collections: [], fields: [], dataSourcesRoles: [], dataSourcesRolesResources: [], dataSourcesRolesResourcesActions: [] };
  const seq = { collections: 1, fields: 1, dataSourcesRoles: 1, dataSourcesRolesResources: 1, dataSourcesRolesResourcesActions: 1 };
  const syncOrder = [];
  const rlsOrder = [];
  const collectionsMap = new Map();

  const db = {
    getRepository(name) {
      if (!store[name]) { store[name] = []; seq[name] = 1; }
      return {
        async find({ filter = {} } = {}) { return store[name].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)); },
        async findOne({ filter = {} } = {}) { return store[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) || null; },
        async count() { return store[name].length; },
        async create({ values }) { const row = { id: seq[name]++, ...structuredClone(values) }; store[name].push(row); return { ...row }; },
        async update({ filter = {}, filterByTk, values }) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          for (const row of store[name]) {
            if (Object.entries(eff).every(([k, v]) => row[k] === v)) Object.assign(row, structuredClone(values));
          }
          return [1];
        },
      };
    },
    collection(def) {
      collectionsMap.set(def.name, def);
      return {
        ...def,
        async sync() { syncOrder.push(def.name); },
      };
    },
    getCollection(name) { return collectionsMap.get(name) || null; },
    async attachLatticeRlsPolicy(tableName) { rlsOrder.push(tableName); },
    sequelize: {
      getDialect: () => 'postgres',
      async query(sql) {
        if (String(sql).includes('FROM pg_class')) return [[{ rls_enabled: true, rls_forced: true }], []];
        return [[], []];
      },
    },
  };

  await createOrUpdateDomainCollection(db, {
    collectionName: 'latticeCustomQuotes',
    title: 'Quotes',
    fields: [
      { name: 'code', type: 'string' },
      { name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags', through: 'latticeCustomQuoteTags', foreignKey: 'quoteId', otherKey: 'tagId' },
    ],
  });

  const joinSyncIdx = syncOrder.indexOf('latticeCustomQuoteTags');
  const mainSyncIdx = syncOrder.indexOf('latticeCustomQuotes');
  assert.ok(joinSyncIdx >= 0 && mainSyncIdx >= 0, 'Both join and main collections must sync');
  assert.ok(joinSyncIdx < mainSyncIdx, `Expected join sync before main sync, got: ${JSON.stringify(syncOrder)}`);

  const joinRlsIdx = rlsOrder.indexOf('latticeCustomQuoteTags');
  const mainRlsIdx = rlsOrder.indexOf('latticeCustomQuotes');
  assert.ok(joinRlsIdx >= 0 && mainRlsIdx >= 0);
  assert.ok(joinRlsIdx < mainRlsIdx, `Expected join RLS before main RLS, got: ${JSON.stringify(rlsOrder)}`);
});

test('Regression (M1.2 R2 F2, F3-bundle, F5, F6): solution-bundle maps formula/json to physical types, syncs join collections first, enforces default key consistency, and validates nested specs', async () => {
  const {
    exportSolutionBundle,
    validateSolutionBundle,
    diffSolutionBundle,
    importSolutionBundle,
  } = require('../src/server/solution-bundle');

  // F5: foreignKey colliding with defaulted singularized otherKey must fail validateSolutionBundle
  const collidingBundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomQuotes',
        title: 'Quotes',
        fields: [
          { name: 'tags', type: 'belongsToMany', target: 'latticeOrders', foreignKey: 'tagId' },
        ],
      },
    ],
  };
  assert.equal(validateSolutionBundle(collidingBundle).valid, false, 'Must reject foreignKey colliding with defaulted otherKey');

  // F6: Deep validation inspection on options.validation, uiSchema[x-validation], uiSchema[x-formula]
  for (const mutator of [
    (f) => { f.options = { validation: { pattern: '(a+)+$' } }; },
    (f) => { f.uiSchema = { 'x-validation': { pattern: '(\\w|a)+$' } }; },
    (f) => { f.uiSchema = { 'x-formula': '__proto__.x' }; },
  ]) {
    const badDeep = {
      metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
      customCollections: [
        {
          name: 'latticeCustomChecks',
          title: 'Checks',
          fields: [{ name: 'code', type: 'string' }],
        },
      ],
    };
    mutator(badDeep.customCollections[0].fields[0]);
    assert.equal(validateSolutionBundle(badDeep).valid, false, 'Must reject malformed nested options/uiSchema validation or formula');
  }

  // F2 + F3 + F5: import maps formula -> storage type, json -> jsonb, defaults singularized keys, and syncs/RLS-protects join before main
  const syncOrder = [];
  const rlsOrder = [];
  const repos = {
    roles: [],
    dataSourcesRolesResources: [],
    dataSourcesRolesResourcesActions: [],
    uiLayouts: [],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    collections: [],
    latticeOrganizations: [{ organizationId: 'org-a', active: true }],
    latticeUiSnapshots: [],
  };
  let seq = 1;
  const db = {
    sequelize: { transaction: async (fn) => fn({ id: 'tx-1' }) },
    hasCollection: (n) => Object.hasOwn(repos, n),
    getCollection: (n) => ({
      name: n,
      sync: async () => { syncOrder.push(n); },
    }),
    attachLatticeRlsPolicy: async (n) => { rlsOrder.push(n); },
    getRepository(name) {
      if (!Object.hasOwn(repos, name)) return null;
      return {
        find: async ({ filter = {} } = {}) => repos[name].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).map((r) => structuredClone(r)),
        findOne: async ({ filter = {} } = {}) => {
          const hit = repos[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          return hit ? structuredClone(hit) : null;
        },
        create: async ({ values }) => {
          const row = { id: ++seq, ...structuredClone(values) };
          repos[name].push(row);
          return structuredClone(row);
        },
        update: async ({ filter = {}, filterByTk, values }) => {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          for (const row of repos[name]) {
            if (Object.entries(eff).every(([k, v]) => row[k] === v)) Object.assign(row, structuredClone(values));
          }
          return [1];
        },
      };
    },
  };

  const bundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomQuotes',
        title: 'Quotes',
        fields: [
          { name: 'qty', type: 'integer' },
          { name: 'meta', type: 'json' },
          { name: 'score', type: 'formula', formulaExpression: 'qty * 2', formulaReturnType: 'integer' },
          { name: 'tags', type: 'belongsToMany', target: 'latticeCustomTags' },
        ],
      },
    ],
  };

  await importSolutionBundle(db, bundle, { dryRun: false, organizationId: 'org-a' });

  const quotesCol = repos.collections.find((c) => c.name === 'latticeCustomQuotes');
  assert.ok(quotesCol);
  const metaField = quotesCol.fields.find((f) => f.name === 'meta');
  assert.equal(metaField.type, 'jsonb');
  assert.equal(metaField.interface, 'json');

  const scoreField = quotesCol.fields.find((f) => f.name === 'score');
  assert.equal(scoreField.type, 'integer');
  assert.equal(scoreField.interface, 'formula');
  assert.equal(scoreField.readOnly, true);
  assert.equal(scoreField.options.formula, 'qty * 2');
  assert.equal(scoreField.options.formulaExpression, 'qty * 2');
  assert.equal(scoreField.options.formulaReturnType, 'integer');
  assert.equal(scoreField.options.readOnly, true);
  assert.equal(scoreField.uiSchema['x-formula'], 'qty * 2');
  assert.equal(scoreField.uiSchema['x-read-pretty'], true);
  assert.equal(scoreField.uiSchema.readOnly, true);

  // F5: singularized default keys matching domain-builder (quoteId / tagId)
  const tagsField = quotesCol.fields.find((f) => f.name === 'tags');
  assert.equal(tagsField.foreignKey, 'quoteId');
  assert.equal(tagsField.otherKey, 'tagId');
  const joinColName = tagsField.through;
  const joinCol = repos.collections.find((c) => c.name === joinColName);
  assert.ok(joinCol);
  assert.ok(joinCol.fields.some((f) => f.name === 'quoteId'));
  assert.ok(joinCol.fields.some((f) => f.name === 'tagId'));

  // F3: join collection synced and RLS-protected BEFORE source collection
  assert.ok(syncOrder.indexOf(joinColName) >= 0 && syncOrder.indexOf('latticeCustomQuotes') >= 0);
  assert.ok(
    syncOrder.indexOf(joinColName) < syncOrder.indexOf('latticeCustomQuotes'),
    `Expected join sync before source sync, got ${JSON.stringify(syncOrder)}`,
  );
  assert.ok(
    rlsOrder.indexOf(joinColName) < rlsOrder.indexOf('latticeCustomQuotes'),
    `Expected join RLS before source RLS, got ${JSON.stringify(rlsOrder)}`,
  );

  // F2 round-trip: export -> validate -> diff -> dryRun import shows zero spurious diffs
  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(validateSolutionBundle(exported).valid, true);
  const dryRoundTrip = await importSolutionBundle(db, exported, { dryRun: true, organizationId: 'org-a' });
  assert.equal(dryRoundTrip.diff.summary.added, 0);
  assert.equal(dryRoundTrip.diff.summary.changed, 0);
  assert.equal(dryRoundTrip.diff.summary.removed, 0);

  // F3 extra: explicitly declared join collection listed AFTER source collection still syncs BEFORE source,
  // and existing incomplete join collection gets repaired before source sync
  syncOrder.length = 0;
  rlsOrder.length = 0;
  repos.collections.push({
    id: ++seq,
    name: 'latticeCustomIncompleteJoin',
    title: 'Incomplete Join',
    fields: [{ name: 'quoteId', type: 'bigInt' }],
  });
  await importSolutionBundle(db, {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomOrdersTwo',
        title: 'Orders 2',
        fields: [
          { name: 'labels', type: 'belongsToMany', target: 'latticeCustomTags', through: 'latticeCustomDeclaredLateJoin', foreignKey: 'orderId', otherKey: 'labelId' },
          { name: 'items', type: 'belongsToMany', target: 'latticeCustomItems', through: 'latticeCustomIncompleteJoin', foreignKey: 'quoteId', otherKey: 'itemId' },
        ],
      },
      {
        name: 'latticeCustomDeclaredLateJoin',
        title: 'Declared Late Join',
        fields: [
          { name: 'orderId', type: 'bigInt', allowNull: false },
          { name: 'labelId', type: 'bigInt', allowNull: false },
        ],
      },
    ],
  }, { dryRun: false, organizationId: 'org-a' });

  const repairedJoin = repos.collections.find((c) => c.name === 'latticeCustomIncompleteJoin');
  assert.ok(repairedJoin.fields.some((f) => f.name === 'organizationId' && f.allowNull === false));
  assert.ok(repairedJoin.fields.some((f) => f.name === 'itemId'));
  assert.ok(syncOrder.indexOf('latticeCustomIncompleteJoin') < syncOrder.indexOf('latticeCustomOrdersTwo'));
  assert.ok(syncOrder.indexOf('latticeCustomDeclaredLateJoin') < syncOrder.indexOf('latticeCustomOrdersTwo'));
  assert.ok(rlsOrder.indexOf('latticeCustomDeclaredLateJoin') < rlsOrder.indexOf('latticeCustomOrdersTwo'));
});

test('Regression (M1.2 R3 AST-ReDoS): parseRegexAst and AST analyzer reject all group wrappers, modifiers, escapes, ranges, nullable/wraparound loops, and adjacent overlaps under 50ms', () => {
  const richSchema = require('../src/server/rich-schema');
  const domainBuilder = require('../src/server/domain-builder');
  assert.equal(typeof richSchema.parseRegexAst, 'function', 'rich-schema must export parseRegexAst');
  assert.equal(typeof domainBuilder.parseRegexAst, 'function', 'domain-builder must export parseRegexAst');

  const { validateSafeRegexPattern, parseRegexAst } = richSchema;
  const parsedSample = parseRegexAst('^(?<prefix>INV|PO)-[0-9]+$');
  assert.equal(parsedSample.type, 'Alt');

  // 1. Group wrappers & ES2025 modifiers
  const wrapperAndModifierRejects = [
    '(?<g>\\w|a)+$',
    '(?<g>a|aa)+$',
    '(?<g>a?b|b)+$',
    '(?<g>a+)+$',
    '(?i:\\w|a)+$',
    '(?i:a|aa)+$',
    '(?i:A|a)+$',
    '(?i:[A-Z]|a)+$',
    '(?i:(?-i:A)|a)+$',
    '(?s:.|\\n)+$',
    '(?i:a+)+$',
    '((\\w|a))+$',
    '((?:\\w|a))+$',
    '((?:a|aa))+$',
    '(?<g>(?:\\w|a))+$',
    '(?:(?<g>(?i:a+)))+$',
    '(?:x?(a|aa))+$',
    '(?:a|(?:b|bb))+$',
    '(?:x(?<g>\\w|a))+$',
    '^((?:a)|(?:a|b))+$',
    '^(?=(a+)+$)',
    '^(?!(a+)+$)',
    '^(?=(\\w|a)+$)',
  ];

  // 2. Escape & character-range equivalence closure
  const escapeAndRangeRejects = [
    '(\\x61|a)+$',
    '(\\u0061|a)+$',
    '(\\u{61}|a)+$',
    '(\\u{61}|u)+$',
    '(\\cA|\\x01)+$',
    '(\\061|1)+$',
    '(\\n|\\x0a)+$',
    '(\\t|\\x09)+$',
    '(\\r|\\x0d)+$',
    '([a-c]|[c-e])+$',
    '([^0-9]|a)+$',
    '([\\x61-\\x63]|b)+$',
    '([\\u0061-\\u0063]|c)+$',
    '([\\u{61}]|u)+$',
    '^(?:\\w|_)+$',
    '^(?:\\d|0)+$',
    '^(?:[\\x30-\\x39]|5)+$',
    '^(?:[\\w]|a)+$',
    '^(?:[\\s]|[\\S])+$',
    '(.|a)+$',
    '^(?:a|aa){2}$',
  ];

  // 3. Nullable body & optional-sequence wraparound closure
  const nullableAndWraparoundRejects = [
    '(a?)+$',
    '(a?b?)+$',
    '(?:|a)+$',
    '(|a)+$',
    '((?:a?))+$',
    '(a?a)+$',
    '(aa?)+$',
    '(?:(?=x)a|a)+$',
  ];

  // 4. Adjacent overlapping quantifier closure
  const adjacentOverlapRejects = [
    '^\\w+\\w+$',
    '^a*a*$',
    '^a*a*a*$',
    '^.*.*$',
    '^[a-z]+a+$',
    '^\\w+\\s*\\w+$',
    '^(?:x[a-z]+)(?:a+y)$',
    '^([a-z]+)(?:b?)([a-z]+)$',
    '^\\d{1,50}\\d{1,50}$',
    '^\\d{1,5}\\d{1,5}\\d{1,5}$',
  ];

  // 5. Syntax / bounds / exotic rejections
  const syntaxAndBoundRejects = [
    '(a)\\1',
    '(?<g>a)\\k<g>',
    '(?<=a)b',
    '(?<!a)b',
    'a{500,}',
    'a{5,2}',
    'a'.repeat(260),
    '[unclosed',
    '(unclosed',
    'unmatched)',
    'a++',
    'a+*',
    '(a)+*',
    'a+'.repeat(101).slice(0, 202),
    '(?u:a)',
    '('.repeat(70) + 'a' + ')'.repeat(70),
  ];

  // 6. Legitimate patterns & false-positive guards
  const legitimatePatterns = [
    '^[A-Z]{2}-\\d{4}$',
    '^[A-Z0-9-]+$',
    '^INV-\\d+$',
    '^INV-[0-9]+$',
    '^T-[0-9]+$',
    '^[a-z0-9_-]+$',
    '^(cat|dog)$',
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^(?:cat|dog)+$',
    '^(?:INV|PO)+$',
    '(\\w|\\d)',
    '^(?<prefix>INV|PO)-[0-9]+$',
    '^(?i:INV|PO)-[0-9]+$',
    '^(?:[A-Z]{2}-\\d{4})$',
    '^(?:a|(?:b|c))+$',
    '^(?:ca(?:t|r))+$',
    '^\\+?\\d{1,4}[- ]?\\d{6,12}$',
    '^-?\\d+(?:\\.\\d+)?$',
    '^https?://[a-z0-9.-]+$',
    '^\\w+_id$',
    '^[a-z0-9-]+-[a-z0-9]+$',
    '^(?:a?b)+$',
    '^(?:ba?)+$',
    '^(?:\\.|a)+$',
    '^\\d+-\\d+$',
    '^[a-z]+\\d+$',
    '^[(?<=]$',
    '^[\\1]$',
    // Without /u flag (Annex B), [\u{61}] is literal [u{61}], which is disjoint from 'a'
    '([\\u{61}]|a)+$',
  ];

  const allRejects = [
    ...wrapperAndModifierRejects,
    ...escapeAndRangeRejects,
    ...nullableAndWraparoundRejects,
    ...adjacentOverlapRejects,
    ...syntaxAndBoundRejects,
  ];

  const t0 = performance.now();
  for (const pat of allRejects) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected rejection for unsafe/invalid pattern: ${pat}`);
  }
  for (const okPat of legitimatePatterns) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass: ${okPat} (${res.error || ''})`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `AST regex validation suite exceeded 50ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R3 Bundle Parity 1): belongsToMany auto-join round-trip and rollback yield zero spurious changed diffs', async () => {
  const {
    exportSolutionBundle,
    validateSolutionBundle,
    diffSolutionBundle,
    importSolutionBundle,
    rollbackLastSolutionBundle,
  } = require('../src/server/solution-bundle');

  function createParityDb() {
    const repos = {
      roles: [],
      dataSourcesRolesResources: [],
      dataSourcesRolesResourcesActions: [],
      uiLayouts: [],
      desktopRoutes: [],
      desktopRoutesUiLayouts: [],
      rolesDesktopRoutes: [],
      flowModels: [],
      collections: [],
      latticeOrganizations: [{ organizationId: 'org-a', active: true }],
      latticeUiSnapshots: [],
    };
    let seq = 1;
    return {
      repos,
      db: {
        sequelize: { transaction: async (fn) => fn({ id: 'tx-1' }) },
        hasCollection: (n) => Object.hasOwn(repos, n),
        getCollection: (n) => ({ name: n, sync: async () => {} }),
        attachLatticeRlsPolicy: async () => {},
        getRepository(name) {
          if (!Object.hasOwn(repos, name)) return null;
          return {
            find: async ({ filter = {} } = {}) =>
              repos[name]
                .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
                .map((r) => structuredClone(r)),
            findOne: async ({ filter = {} } = {}) => {
              const hit = repos[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
              return hit ? structuredClone(hit) : null;
            },
            create: async ({ values }) => {
              const row = { id: ++seq, ...structuredClone(values) };
              repos[name].push(row);
              return structuredClone(row);
            },
            update: async ({ filter = {}, filterByTk, values }) => {
              const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
              for (const row of repos[name]) {
                if (Object.entries(eff).every(([k, v]) => row[k] === v)) Object.assign(row, structuredClone(values));
              }
              return [1];
            },
          };
        },
      },
    };
  }

  const { db } = createParityDb();
  const initialBundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomQuotes',
        title: 'Quotes',
        fields: [
          { name: 'code', type: 'string' },
          { name: 'tags', type: 'belongsToMany', target: 'latticeOrders' },
        ],
      },
    ],
  };

  await importSolutionBundle(db, initialBundle, { dryRun: false, organizationId: 'org-a' });
  const exp1 = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(validateSolutionBundle(exp1).valid, true);

  // Import exp1 into a fresh DB and into the same DB, then export exp2 and diff
  const fresh = createParityDb();
  await importSolutionBundle(fresh.db, exp1, { dryRun: false, organizationId: 'org-a' });
  const expFresh = await exportSolutionBundle(fresh.db, { organizationId: 'org-a' });
  assert.deepEqual(diffSolutionBundle(exp1, expFresh).summary, { added: 0, changed: 0, unchanged: 2, removed: 0 });

  await importSolutionBundle(db, exp1, { dryRun: false, organizationId: 'org-a' });
  const exp2 = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.deepEqual(diffSolutionBundle(exp1, exp2).summary, { added: 0, changed: 0, unchanged: 2, removed: 0 });

  // Mutate options on both collections, import, then rollback and assert changed === 0
  const mutated = structuredClone(exp1);
  mutated.customCollections = mutated.customCollections.map((c) => ({
    ...c,
    options: { ...(c.options || {}), titleField: 'code', uiManageable: true },
  }));
  await importSolutionBundle(db, mutated, { dryRun: false, organizationId: 'org-a' });
  await rollbackLastSolutionBundle(db, { organizationId: 'org-a' });
  const expAfterRb = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(diffSolutionBundle(exp1, expAfterRb).summary.changed, 0);
});

test('Regression (M1.2 R3 Bundle Parity 2): domain-builder -> export -> import -> export -> diff and rollback preserve collection options parity', async () => {
  const { createOrUpdateDomainCollection } = require('../src/server/domain-builder');
  const {
    exportSolutionBundle,
    diffSolutionBundle,
    importSolutionBundle,
    rollbackLastSolutionBundle,
  } = require('../src/server/solution-bundle');

  const repos = {
    collections: [],
    fields: [],
    roles: [],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    dataSourcesRolesResourcesActions: [],
    uiLayouts: [],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    latticeOrganizations: [{ organizationId: 'org-a', active: true }],
    latticeUiSnapshots: [],
  };
  let seq = 1;
  const collectionsMap = new Map();
  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (fn) => fn({ id: 'tx-1' }),
      query: async (sql) => {
        if (String(sql).includes('FROM pg_class')) return [[{ rls_enabled: true, rls_forced: true }], []];
        return [[], []];
      },
    },
    hasCollection: (n) => Object.hasOwn(repos, n),
    collection(def) {
      collectionsMap.set(def.name, def);
      return { ...def, async sync() {} };
    },
    getCollection: (n) => collectionsMap.get(n) || { name: n, sync: async () => {} },
    attachLatticeRlsPolicy: async () => {},
    getRepository(name) {
      if (!Object.hasOwn(repos, name)) return null;
      return {
        async find({ filter = {}, appends = [] } = {}) {
          const rows = repos[name]
            .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
            .map((r) => structuredClone(r));
          if (name === 'collections' && Array.isArray(appends) && appends.includes('fields')) {
            for (const row of rows) {
              row.fields = repos.fields
                .filter((f) => f.collectionName === row.name)
                .map((f) => structuredClone(f));
            }
          }
          return rows;
        },
        async findOne({ filter = {}, appends = [] } = {}) {
          const hit = repos[name].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          if (!hit) return null;
          const copy = structuredClone(hit);
          if (name === 'collections' && Array.isArray(appends) && appends.includes('fields')) {
            copy.fields = repos.fields
              .filter((f) => f.collectionName === copy.name)
              .map((f) => structuredClone(f));
          }
          return copy;
        },
        async count() {
          return repos[name].length;
        },
        async create({ values }) {
          const row = { id: ++seq, ...structuredClone(values) };
          if (name === 'collections' && Array.isArray(values?.fields)) {
            for (const f of values.fields) {
              repos.fields.push({ id: ++seq, collectionName: row.name, ...structuredClone(f) });
            }
            delete row.fields;
          }
          repos[name].push(row);
          return structuredClone(row);
        },
        async update({ filter = {}, filterByTk, values }) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          for (const row of repos[name]) {
            if (Object.entries(eff).every(([k, v]) => row[k] === v)) {
              const cleanValues = structuredClone(values);
              if (name === 'collections' && Array.isArray(cleanValues.fields)) {
                repos.fields = repos.fields.filter((f) => f.collectionName !== row.name);
                for (const f of cleanValues.fields) {
                  repos.fields.push({ id: ++seq, collectionName: row.name, ...f });
                }
                delete cleanValues.fields;
              }
              Object.assign(row, cleanValues);
            }
          }
          return [1];
        },
      };
    },
  };

  await createOrUpdateDomainCollection(db, {
    collectionName: 'latticeCustomInvoices',
    title: 'Invoices',
    fields: [
      { name: 'code', type: 'string', validation: { required: true, pattern: '^INV-[0-9]+$' } },
      { name: 'qty', type: 'integer', validation: { min: 1 } },
      { name: 'total', type: 'formula', formulaExpression: 'qty * 10' },
      { name: 'tags', type: 'belongsToMany', target: 'latticeOrders' },
    ],
  });

  const exp1 = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(exp1.customCollections.length, 2);
  await importSolutionBundle(db, exp1, { dryRun: false, organizationId: 'org-a' });
  const exp2 = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.deepEqual(diffSolutionBundle(exp1, exp2).summary, { added: 0, changed: 0, unchanged: 2, removed: 0 });

  const mutated = structuredClone(exp1);
  mutated.customCollections[0].options = { titleField: 'code', uiManageable: true };
  await importSolutionBundle(db, mutated, { dryRun: false, organizationId: 'org-a' });
  await rollbackLastSolutionBundle(db, { organizationId: 'org-a' });
  const expAfterRb = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(diffSolutionBundle(exp1, expAfterRb).summary.changed, 0);
});

test('Regression (M1.2 R3 Formula Inference): validateSolutionBundle and normalizeBundleCustomField infer omitted formulaReturnType from AST', async () => {
  const { validateSolutionBundle, importSolutionBundle } = require('../src/server/solution-bundle');

  const validBundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomInferredFormulas',
        title: 'Inferred Formulas',
        fields: [
          { name: 'qty', type: 'integer' },
          { name: 'label', type: 'formula', formulaExpression: 'CONCAT("A-", qty)', validation: { pattern: '^A-\\d+$' } },
          { name: 'isHigh', type: 'formula', formulaExpression: 'qty > 10' },
          { name: 'nameLen', type: 'formula', formulaExpression: 'LEN(label)' },
        ],
      },
    ],
  };

  const validCheck = validateSolutionBundle(validBundle);
  assert.equal(validCheck.valid, true, `Expected inferred string formula with pattern to validate, got: ${validCheck.errors?.join('; ')}`);

  const invalidBoolMinBundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v3', organizationId: 'org-a' },
    customCollections: [
      {
        name: 'latticeCustomInferredFormulas',
        title: 'Inferred Formulas',
        fields: [
          { name: 'qty', type: 'integer' },
          { name: 'isHigh', type: 'formula', formulaExpression: 'qty > 10', validation: { min: 1 } },
        ],
      },
    ],
  };
  assert.equal(validateSolutionBundle(invalidBoolMinBundle).valid, false, 'Must reject validation.min on inferred boolean formula');

  const collections = [];
  let seq = 1;
  const db = {
    sequelize: { transaction: async (fn) => fn({ id: 'tx-1' }) },
    hasCollection: (n) => n === 'collections' || n === 'latticeOrganizations' || n === 'latticeUiSnapshots',
    getCollection: (n) => ({ name: n, sync: async () => {} }),
    getRepository(name) {
      if (name === 'latticeOrganizations') return { find: async () => [{ organizationId: 'org-a', active: true }] };
      if (name === 'latticeUiSnapshots') return { find: async () => [], create: async ({ values }) => values };
      if (name === 'collections') {
        return {
          find: async () => collections.map((c) => structuredClone(c)),
          findOne: async ({ filter = {} } = {}) => collections.find((c) => c.name === filter.name) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, ...structuredClone(values) };
            collections.push(row);
            return structuredClone(row);
          },
          update: async () => [1],
        };
      }
      return { find: async () => [], findOne: async () => null };
    },
  };

  await importSolutionBundle(db, validBundle, { dryRun: false, organizationId: 'org-a' });
  const saved = collections.find((c) => c.name === 'latticeCustomInferredFormulas');
  assert.ok(saved);

  const labelField = saved.fields.find((f) => f.name === 'label');
  assert.equal(labelField.type, 'string');
  assert.equal(labelField.formulaReturnType, 'string');
  assert.equal(labelField.uiSchema['x-component'], 'Input');

  const isHighField = saved.fields.find((f) => f.name === 'isHigh');
  assert.equal(isHighField.type, 'boolean');
  assert.equal(isHighField.formulaReturnType, 'boolean');
  assert.equal(isHighField.uiSchema['x-component'], 'Checkbox');

  const nameLenField = saved.fields.find((f) => f.name === 'nameLen');
  assert.equal(nameLenField.type, 'integer');
  assert.equal(nameLenField.formulaReturnType, 'integer');
});

test('Regression (M1.2 R4 AST-ReDoS & ClassControlEscape): bounded-span chains through optional/alt items, nullable bridges, and Annex-B [\\c0-9_] escapes are rejected while legitimate patterns pass', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // Variant 1A: non-nullable Seq with optional trailing/leading atoms or Alt branches
    `^${'(?:a{1,10}b?)'.repeat(10)}$`,
    `^${'(?:\\w{1,10}-?)'.repeat(10)}$`,
    `^${'(?:b?a{1,10}c?)'.repeat(3)}$`,
    `^${'(?:a{1,10}|xy)'.repeat(10)}$`,
    '^(\\d{1,5})(\\d{1,5}|a{1,5})(\\d{1,5})$',
    // Variant 1B: disjoint nullable variable repeat bridge preserving accumulated chainSpan
    '^a{1,30}b{0,2}a{1,30}c{0,2}a{1,30}d{0,2}a{1,30}e{0,2}a{1,30}f{0,2}a{1,30}g{0,2}a{1,30}h{0,2}a{1,30}$',
    '^\\d{1,50}b{0,4}\\d{1,50}$',
    // Annex-B ClassControlEscape inside [...]
    '([\\c0]|\\x10)+$',
    '([\\c1]|\\x11)+$',
    '([\\c9]|\\x19)+$',
    '([\\c_]|\\x1f)+$',
  ];

  const mustAllow = [
    '^\\+?\\d{1,4}[- ]?\\d{6,12}$',
    '^-?\\d+(?:\\.\\d+)?$',
    '^https?://[a-z0-9.-]+$',
    '^\\w+_id$',
    '^(?:a{1,5}x)(?:a{1,5})$',
  ];

  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected ReDoS/escape rejection for: ${pat}`);
  }
  for (const pat of mustAllow) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass: ${pat} (${res.error || ''})`);
  }
});

test('Regression (M1.2 R4 domain-builder formulaReturnType): sanitizeFields forwards inferred formulaReturnType to sanitizeFieldValidation', () => {
  const { sanitizeFields } = require('../src/server/domain-builder');

  const okFields = sanitizeFields([
    { name: 'qty', type: 'integer' },
    {
      name: 'label',
      type: 'formula',
      formulaExpression: 'CONCAT("A-", qty)',
      validation: { pattern: '^A-\\d+$' },
    },
  ], { collectionName: 'latticeCustomFormulaCheck' });

  const label = okFields.find((f) => f.name === 'label');
  assert.ok(label);
  assert.equal(label.formulaReturnType, 'string');
  assert.deepEqual(label.validation, { pattern: '^A-\\d+$' });

  assert.throws(
    () => sanitizeFields([
      { name: 'qty', type: 'integer' },
      {
        name: 'isHigh',
        type: 'formula',
        formulaExpression: 'qty > 10',
        validation: { min: 1 },
      },
    ], { collectionName: 'latticeCustomFormulaCheck' }),
    /validation\.min is not supported on "boolean"/,
  );
});

test('Regression (M1.2 R5 Compositional Seq Chain Algebra & Edge Cases): rejects all ?/Alt/bridge/modifier/unicode-escape ReDoS bypasses while allowing linear real-world patterns under 50ms', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // Class 1: ? / {0,1} chains, zero-quantifier Alt chains, optional multi-char, lookahead + ?
    `^${'a?'.repeat(30)}$`,
    `^${'(?:a?)'.repeat(30)}$`,
    `^${'(?:a|b)?'.repeat(30)}$`,
    `^${'\\d?'.repeat(30)}$`,
    `^${'(?i:a?)'.repeat(30)}$`,
    `^${'(?:ax)?'.repeat(30)}$`,
    `^${'(?:a?b?)'.repeat(30)}$`,
    `^${'(?:\\.\\d+)?'.repeat(30)}$`,
    `^${'a?a'.repeat(30)}$`,
    `^${'(?:a|)'.repeat(30)}$`,
    `^${'(?:ax|)'.repeat(30)}$`,
    `^${'(?:a|aa)'.repeat(28)}$`,
    `^${'(?:a|aa)'.repeat(30)}$`,
    `^${'(?:a|b?)'.repeat(25)}$`,
    `^${'(?:a?|b?)'.repeat(25)}$`,
    `^${'(?:a|ab?)'.repeat(30)}$`,
    `^(?=${'(?:a?)'.repeat(30)}$)`,
    `^${'(?:(?=a)a?)'.repeat(20)}$`,
    `^a+${'a?'.repeat(10)}$`,
    '^a?a?a?a+$',
    '^a{1,10}a+$',
    '^a{1,50}a+$',
    '^(?:a{1,50}|a+)a{1,3}$',

    // Class 2: Intersecting mandatory fixed atoms, multi-char bridges, (?i:...) variants
    `^${'a{1,10}a'.repeat(10)}$`,
    `^${'a{1,10}a{5}'.repeat(10)}$`,
    `^${'(?:a{1,10}a)'.repeat(10)}$`,
    `^${'(?:aa{1,10})'.repeat(10)}$`,
    `^${'(?:a{1,10}a|xy)'.repeat(10)}$`,
    `^${'(?:a{1,10}a|b)'.repeat(10)}$`,
    '^a{1,30}aa{1,30}aa{1,30}aa{1,30}aa{1,30}aa{1,30}aa{1,30}a$',
    '^\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}\\d\\d{1,30}$',
    `^${'(?:[ab]{1,10}ab)'.repeat(10)}$`,
    `^${'(?:\\w{1,10}ab)'.repeat(10)}$`,
    `^${'(?i:a{1,10}A)'.repeat(10)}$`,
    `^${'(?i:a{1,10}[A])'.repeat(10)}$`,
    `^${'(?i:[a-z]{1,10}[A-Z])'.repeat(10)}$`,
    `^${'(?i:a?A?)'.repeat(15)}$`,
    '^a{1,10}[ab]a{1,10}[ab]a{1,10}$',
    '^[a-z0-9-]+-[a-z0-9-]+$',

    // Class 3: Multi-repeat Group/Seq/Alt blocks
    `^${'(?:a{1,10}a{1,10})'.repeat(10)}$`,
    `^${'(?:a{1,10}b?a{1,10})'.repeat(8)}$`,
    `^${'(?:a{1,10}b{0,2}a{1,10})'.repeat(5)}$`,
    `^${'(?:a{1,10}x)?'.repeat(10)}$`,
    `^${'(?:a{1,10}|b{1,10})'.repeat(10)}$`,
    `^${'(?:x?a{1,10})'.repeat(10)}$`,
    `^${'(?:a{1,10}x?)'.repeat(10)}$`,
    `^${'(?:a{1,10}\\ba{1,10})'.repeat(5)}$`,
    `^${'(?i:a{1,10}A{1,10})'.repeat(10)}$`,
    `^${'(?i:\\d{1,10}5\\d{1,10})'.repeat(5)}$`,
    `^${'(?i:\\w{1,10}A\\w{1,10})'.repeat(5)}$`,
    '^(?:\\.\\d+)?\\d+$',

    // Class 4: Non-/u \p{...} / \P{...} & wide non-ASCII (?i:...) case folding
    `^${'\\p{1,30}'.repeat(10)}$`,
    `^${'\\P{1,30}'.repeat(10)}$`,
    '(\\p{L}|a)+$',
    '[\\p{L}]+$',
    '(?i:[\\u0391-\\u042f]|[\\u0430-\\u04ff])+$',
  ];

  const mustAllow = [
    // Existing & linear ? + real-world compatibility patterns
    '^0?\\d+$',
    '^a?a+$',
    '^(?:a{1,5}|a+)a{1,2}$',
    '^_?[a-zA-Z0-9_]+$',
    '^/?[a-z0-9/_-]+$',
    '^https?://(?:www\\.)?[a-z0-9.-]+$',
    '^(?:https?://)?(?:www\\.)?[a-z0-9.-]+\\.[a-z]{2,}(?:/[^\\s]*)?$',
    '^(?:https?://)?[a-z0-9.-]+(?:/[a-z0-9.-]+)?$',
    '^https?://[a-zA-Z0-9.-]+(?::\\d{1,5})?(?:/[^\\s?#]*)?$',
    '^https?://[a-z0-9.-]+$',
    '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    '^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})?)?$',
    '^\\+?[1-9]\\d{1,14}$',
    '^0?[1-9]\\d{8,9}$',
    '^\\+?\\d{1,4}[- ]?\\d{6,12}$',
    '^[A-Z]{2,5}-\\d{4,8}(?:-[A-Z0-9]{1,4})?$',
    '^(?<prefix>INV|PO)-\\d{4}-\\d{4,8}$',
    '^[+-]?\\d+(?:\\.\\d{1,4})?$',
    '^-?\\d+(?:\\.\\d+)?$',
    '^\\w+_id$',
    '^[a-z]+a$',
    '^[a-zA-Z0-9_-]{1,80}$',
    '^[a-z0-9-]+-[a-z0-9]+$',
    '^[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+$',
    '^(?:a{1,5}x)(?:a{1,5})$',
    '^(?:a?)(?:b?)(?:c?)$',
    '^[(?<=]$',
    '^[\\c0-\\c9]+$',
    '^(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d]{8,32}$',
    '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
    `^${'(?:a?x)'.repeat(30)}$`,
    `^${'(?:a{1,10}x)'.repeat(10)}$`,
    `^${'(?:a{1,10}x|xy)'.repeat(10)}$`,
    '^(?:a{1,30}|b{1,30})(?:c{1,30}|d{1,30})$',
    '^(?:a{1,10}x|b{1,10})(?:a{1,10})$',
    `^${'a{1,10}ab'.repeat(10)}$`,
    '^(?:a{1,5}|b{1,5})(?:b{1,5}|c{1,5})(?:c{1,5}|d{1,5})(?:d{1,5}|e{1,5})$',
    '^(?:a{1,10}b?a{1,10})$',
    '^(?:cat|dog)(?:cat|dog)(?:cat|dog)$',
    '^\\w{1,50}\\b\\W+\\b\\w{1,50}$',
    '^(?=a+)a+$',
  ];

  const t0 = performance.now();
  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected ReDoS/escape rejection for: ${pat}`);
  }
  for (const okPat of mustAllow) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass: ${okPat} (${res.error || ''})`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `R5 AST regex validation suite exceeded 50ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R6 Disjoint-Separator Overlap, skipOverlap Repeat(min>=1), and Frontier-Overflow bridgeAtoms)', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // 1. Disjoint-separator unrolled overlapping junctions (Reviewer 5 + Challenger 5)
    `^${'(?:a?ba?)'.repeat(25)}$`,
    `^${'(?:a{1,5}ba{1,5})'.repeat(14)}$`,
    `^${'(?:a{1,5}:a{1,5})'.repeat(14)}$`,
    `^${'(a{1,5}a{1,5})x'.repeat(16)}$`,
    `^${'(a|ab)b?c'.repeat(25)}$`,
    `^${'(a|ab)b?c'.repeat(28)}$`,
    `^${'(a|ab)b*c'.repeat(25)}$`,
    `^${'(a|ab)b?x'.repeat(25)}$`,
    `^${'(a|aa)a?x'.repeat(25)}$`,
    `^${'(a|a?a)x'.repeat(25)}$`,
    `^${'(ab|a?b)x'.repeat(22)}$`,
    `^${'(a|ab)(bc|c)'.repeat(21)}$`,

    // 2. skipOverlap in Repeat(max > 1, min >= 1) after nullable Alt chains
    `^${'(?:a|)'.repeat(6)}a+$`,
    `^${'(?:a|)'.repeat(6)}a{1,50}$`,
    `^${'(?:ax|)'.repeat(6)}a{1,50}$`,
    `^${'(?:a|b|)'.repeat(6)}a+$`,

    // 3. mergeChainStates bridgeAtoms clobber on 13+ branch Alt frontier overflow
    '^(?:b{1,2}|c{1,2}|d{1,2}|e{1,2}|f{1,2}|g{1,2}|h{1,2}|i{1,2}|j{1,2}|k{1,2}|l{1,2}|a+|m{1,9}m)a+$',
    '^(?:b{1,2}|c{1,2}|d{1,2}|e{1,2}|f{1,2}|g{1,2}|h{1,2}|i{1,2}|j{1,2}|k{1,2}|l{1,2}|a{1,50}|m{1,9}m)a{1,50}$',
    '^(?:b{1,2}|c{1,2}|d{1,2}|e{1,2}|f{1,2}|g{1,2}|h{1,2}|i{1,2}|j{1,2}|k{1,2}|l{1,2}|a{1,10}a|m{1,9}m)a{1,10}a{1,10}$',
  ];

  const mustAllow = [
    '^0?\\d+x0?\\d+$',
    '^(?:a{1,5}x)(?:a{1,5})$',
    '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
    '^0?\\d+$',
    '^_?[a-zA-Z0-9_]+$',
    '^/?[a-z0-9/_-]+$',
    '^https?://(?:www\\.)?[a-z0-9.-]+$',
  ];

  const t0 = performance.now();
  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected R6 ReDoS rejection for: ${pat}`);
  }
  for (const okPat of mustAllow) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass R6: ${okPat} (${res.error || ''})`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `R6 AST regex validation suite exceeded 50ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R7 Multi-Empty-Branch Alt & Quantified Prefix Feeding Disjoint-firstChars Alt)', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // 1. Multi-empty-branch Alt (emptyBranchCount >= 2)
    `^${'(?:|a|)x'.repeat(30)}$`,
    `^${'(?:|a|)x'.repeat(25)}$`,
    `^${'(?:|||)x'.repeat(15)}$`,
    `^${'(?:||a)x'.repeat(20)}$`,
    `^${'(?:(?:|)|a)x'.repeat(20)}$`,

    // 2. Quantified/optional prefix feeding disjoint-firstChars Alt
    `^${'a?(ab|b)'.repeat(25)}$`,
    `^${'a?(ab|b)'.repeat(28)}$`,
    `^${'a?(ab|b)x'.repeat(25)}$`,
    `^${'a+(ab|b)'.repeat(25)}$`,
    `^${'a+(ab|b)x'.repeat(25)}$`,
    `^${'a*(ab|b)'.repeat(25)}$`,
    `^${'a?b?(abc|bc|c)'.repeat(16)}$`,
    `^${'a?b?c?(abcd|bcd|cd|d)'.repeat(12)}$`,
    `^${'a{1,5}(ab|b)'.repeat(21)}$`,
    `^${'(ab)?(abc|c)'.repeat(20)}$`,
    `^${'a?(ab|b|bc)'.repeat(25)}$`,
    `^${'a?b?c?d?(abcde|bcde|cde|de|e)'.repeat(9)}$`,
  ];

  const mustAllow = [
    '^0?(?:[1-9]\\d*|0)$',
    '^0?(?:10|20|30)$',
    '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
    '^(?:0?\\d|1\\d|2[0-3]):[0-5]\\d$',
    '^(?:Mr|Ms|Dr)?\\.?\\s*[A-Z][a-z]+$',
    `^${'(?:|a)x'.repeat(25)}$`,
    '^[+-]?(?:\\d+\\.\\d+|\\.\\d+|\\d+)$',
    '^0?\\d+x0?\\d+x0?\\d+$',
    '^(?:a{1,5}|b{1,5})(?:b{1,5}|c{1,5})(?:c{1,5}|d{1,5})(?:d{1,5}|e{1,5})$',
  ];

  const t0 = performance.now();
  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected R7 ReDoS rejection for: ${pat}`);
  }
  for (const okPat of mustAllow) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass R7: ${okPat} (${res.error || ''})`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `R7 AST regex validation suite exceeded 50ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R8 Multi-Char Repeat Sequences & Partial Mandatory-Atom Cursors): rejects all 13 Challenger 7 ReDoS bypasses while allowing legitimate patterns under 50ms', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // Bypass Family 1A: Chained/adjacent multi-char Repeat(min >= 1) with disjoint firstChars/lastChars
    `^${'(?:ab)+'.repeat(10)}$`,
    `^${'(?:ab)+'.repeat(6)}$`,
    `^${'(?:ab){1,50}'.repeat(6)}$`,
    `^${'(?:ab){1,100}'.repeat(5)}$`,
    `^${'(ab)+ab(ab)+'.repeat(5)}$`,
    `^${'(?:a\\d)+'.repeat(8)}$`,
    `^${'(?:ab|cd)+'.repeat(8)}$`,

    // Bypass Family 1B: Multi-char Repeat(min === 0) bridged by mandatory literal matching body
    `^${'(?:ab){0,50}ab(?:ab){0,50}x'.repeat(5)}$`,
    `^${'(?:ab){0,30}ab(?:ab){0,30}x'.repeat(5)}$`,
    `^${'(ab)?ab(ab)?x'.repeat(19)}$`,

    // Bypass Family 2: Multi-char prefix cursor advancing across partial mandatory atom into Alt
    `^${'(ab)+a(ba|)'.repeat(23)}$`,
    `^${'(ab)+a(bac|c)'.repeat(19)}$`,
    `^${'(ab)?a(bac|c)'.repeat(19)}$`,

    // Additional structural multi-char cursor & bridge variants
    '^(?:ab)+c?(?:ab)+$',
    '^(?:abc)+abc(?:abc)+$',
    '^(?:abc)+ab(?:cab)+$',
    '^(?:ab)+(?:abab)+$',
    '^(?i:ab)+AB(?i:ab)+$',
    `^${'(?:a?b)+'.repeat(6)}$`,
    `^${'(?:ab?)+'.repeat(6)}$`,
    '^(?:ab)+a(?:b|c)(?:ab)+$',
    `^${'(ab)+a(b|x)a(ba|)'.repeat(14)}$`,
    `^${'(abcd)?a(bcdac|c)'.repeat(12)}$`,
    `^${'(abcd)?ab(cdab|d)'.repeat(12)}$`,
    `^${'(ab)?(ab|cd)'.repeat(19)}$`,
  ];

  const mustAllow = [
    // Disjoint-delimited and single-use multi-char patterns
    '^(?:ab)+x(?:ab)+$',
    '^(?:ab){1,5}x(?:ab){1,5}$',
    '^(?:ab)+ac(?:ab)+$',
    '^(?:ab)+aab(?:ab)+$',
    '^(?:aba)+ab(?:aba)+$',
    `^${'(?:ab)+ax'.repeat(10)}$`,
    `^${'(ab)?abx'.repeat(30)}$`,
    `^${'(ab)?a(ac|ef)'.repeat(19)}$`,
    '^(?:ab|cd)+(?:ef|gh)+$',
    '^(?:ab)+a(b)?$',
    '^(?:ab){1,5}(?:ab){1,5}$',
    '^(?:ab)?ab(ab)?$',
    '^(?:ab)+ab$',
    // Prior R5/R6/R7 legitimate patterns
    '^0?\\d+x0?\\d+x0?\\d+$',
    '^(?:a{1,5}x)(?:a{1,5})$',
    '^(?:cat|dog)(?:cat|dog)(?:cat|dog)$',
    '^[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+$',
    '^(?:a{1,5}|b{1,5})(?:b{1,5}|c{1,5})(?:c{1,5}|d{1,5})(?:d{1,5}|e{1,5})$',
    '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
    '^(?:Mr|Ms|Dr)?\\.?\\s*[A-Z][a-z]+$',
    '^0?(?:[1-9]\\d*|0)$',
    '^0?(?:10|20|30)$',
    '^[+-]?(?:\\d+\\.\\d+|\\.\\d+|\\d+)$',
    `^${'(?:|a)x'.repeat(25)}$`,
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
    '^\\+?[1-9]\\d{1,14}$',
    '^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})?)?$',
    '^(?:https?://)?(?:www\\.)?[a-z0-9.-]+\\.[a-z]{2,}(?:/[^\\s]*)?$',
    '^[A-Z]{2,5}-\\d{4,8}(?:-[A-Z0-9]{1,4})?$',
  ];

  const t0 = performance.now();
  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected R8 ReDoS rejection for: ${pat}`);
  }
  for (const okPat of mustAllow) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass R8: ${okPat} (${res.error || ''})`);
    const input = '0'.repeat(4000) + '!';
    const tRun0 = performance.now();
    res.regex.test(input);
    const runMs = performance.now() - tRun0;
    assert.ok(runMs < 5, `Legitimate pattern "${okPat}" took ${runMs.toFixed(2)}ms on 4000-char input`);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `R8 AST regex validation suite exceeded 50ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R9 Overflow Envelopes, >16-Char Sequences, & Partial-Cycle Tail-Completion Repeats): rejects all 26 C8/R8 ReDoS bypasses while allowing legitimate & disjoint-separated patterns under 5ms', () => {
  const { validateSafeRegexPattern } = require('../src/server/rich-schema');

  const mustReject = [
    // Family A: MAX_REPEAT_SEQ_PATHS = 12 threshold drops (C8 B.1 + R8 C.1, C.4-C.7, C.9)
    `^${'(?:a0|b1|c2|d3|e4|f5|g6|h7|i8|j9|k0|l1|m2)+'.repeat(5)}$`,
    `^${'(?:ab|cd|ef|gh|ij|kl|mn|op|qr|st|uv|wx|yz)+'.repeat(5)}$`,
    `^${'(?:a0|b1|c2|d3|e4|f5|g6|h7|i8|j9|k0|l1|m2){1,50}'.repeat(5)}$`,
    `^${'(?:a0|b1|c2|d3|e4|f5|g6|h7|i8|j9|k0|l1|m2)+a0(?:a0|b1|c2|d3|e4|f5|g6|h7|i8|j9|k0|l1|m2)+'.repeat(2)}$`,
    `^${'(?:x(?:a?b?c?d?)y)+'.repeat(10)}$`,
    `^${'(?:x(?:a?b?c?d?)y){1,50}'.repeat(6)}$`,
    `^${'(?:(?:a|b)(?:c|d)(?:e|f)(?:g|h))+'.repeat(7)}$`,
    `^${'(?:ab?c?d?e?f?h)+'.repeat(6)}$`,
    `^${'(?:(?:a|b|c|d)(?:e|f|g|h))+'.repeat(6)}$`,
    `^${'(?:(?:a|b|c|d)(?:e|f|g|h)){1,50}'.repeat(6)}$`,
    `^${'(?:(?:a|b)(?:c|d)(?:e|f)(?:g|h)){1,50}'.repeat(5)}$`,
    `^${'(?:a1|b1|c1|d1|e1|f1|g1|h1|i1|j1|k1|l1|m1)+'.repeat(5)}$`,
    `^${'(?:(?:a|b|c|d)(?:e|f|g|h)){0,100}ae(?:(?:a|b|c|d)(?:e|f|g|h)){0,100}x'.repeat(3)}$`,

    // Family B: MAX_REPEAT_SEQ_LEN = 16 threshold drops (C8 B.2 + R8 C.2, C.3, C.8)
    `^${'(?:a000000000000000b)+'.repeat(10)}$`,
    `^${'(?:a000000000000000b)+'.repeat(6)}$`,
    `^${'(?:a000000000000000b){1,50}'.repeat(6)}$`,
    `^${'(?:abcdefghijklmnopq)+'.repeat(6)}$`,
    `^${'(?:abcdefghijklmnopq)+'.repeat(8)}$`,
    `^${'(?:abcdefghijklmnopq){1,50}'.repeat(6)}$`,

    // Family C: Partial-cycle tail-completion Repeat tracking (C8 B.3 + edge variants)
    `^${'(?:ab)+ab+'.repeat(12)}$`,
    `^${'(?:ab)+a(?:b)+'.repeat(12)}$`,
    `^${'(?:ab){1,50}a(?:b){1,50}'.repeat(8)}$`,
    `^${'(?:abc)+a(?:bc)+'.repeat(10)}$`,
    `^${'(?:abc)+ab(?:c)+'.repeat(10)}$`,
    `^${'(?:abcd)+a(?:bcd)+'.repeat(10)}$`,
    `^${'(?:ab|cd)+a(?:b)+'.repeat(10)}$`,
    `^${'(?:ab)?a(?:b)?'.repeat(15)}$`,
    `^${'(?:ab)?a(?:b)+'.repeat(12)}$`,
    `^${'(?:abb)+a(?:b)+'.repeat(10)}$`,
  ];

  const mustAllow = [
    // New R9 disjoint-separated & single-use controls
    '^(?:a1|b1|c1|d1|e1|f1|g1|h1|i1|j1|k1|l1|m1)+x(?:a1|b1|c1|d1|e1|f1|g1|h1|i1|j1|k1|l1|m1)+$',
    '^(?:abcdefghijklmnopq)+x(?:abcdefghijklmnopq)+$',
    '^(?:ab?c?d?e?f?h)+x(?:ab?c?d?e?f?h)+$',
    '^(?:abc)+(?:ab)+$',
    '^(?:abc)+a(?:bc)$',
    '^(?:ab)+ab+$',
    '^(?:ab)+a(?:b)+$',
    // Existing 30+ legitimate controls
    '^(?:ab)+x(?:ab)+$',
    '^(?:ab){1,5}x(?:ab){1,5}$',
    '^(?:ab)+ac(?:ab)+$',
    '^(?:ab)+aab(?:ab)+$',
    '^(?:aba)+ab(?:aba)+$',
    `^${'(?:ab)+ax'.repeat(10)}$`,
    `^${'(ab)?abx'.repeat(30)}$`,
    `^${'(ab)?a(ac|ef)'.repeat(19)}$`,
    '^(?:ab|cd)+(?:ef|gh)+$',
    '^(?:ab)+a(b)?$',
    '^(?:ab){1,5}(?:ab){1,5}$',
    '^(?:ab)?ab(ab)?$',
    '^(?:ab)+ab$',
    '^0?\\d+x0?\\d+x0?\\d+$',
    '^(?:a{1,5}x)(?:a{1,5})$',
    '^(?:cat|dog)(?:cat|dog)(?:cat|dog)$',
    '^[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+$',
    '^(?:a{1,5}|b{1,5})(?:b{1,5}|c{1,5})(?:c{1,5}|d{1,5})(?:d{1,5}|e{1,5})$',
    '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
    '^(?:Mr|Ms|Dr)?\\.?\\s*[A-Z][a-z]+$',
    '^0?(?:[1-9]\\d*|0)$',
    '^0?(?:10|20|30)$',
    '^[+-]?(?:\\d+\\.\\d+|\\.\\d+|\\d+)$',
    `^${'(?:|a)x'.repeat(25)}$`,
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
    '^\\+?[1-9]\\d{1,14}$',
    '^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})?)?$',
    '^(?:https?://)?(?:www\\.)?[a-z0-9.-]+\\.[a-z]{2,}(?:/[^\\s]*)?$',
    '^[A-Z]{2,5}-\\d{4,8}(?:-[A-Z0-9]{1,4})?$',
  ];

  const t0 = performance.now();
  for (const pat of mustReject) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected R9 ReDoS rejection for: ${pat}`);
  }
  for (const okPat of mustAllow) {
    const res = validateSafeRegexPattern(okPat);
    assert.equal(res.valid, true, `Expected legitimate pattern to pass R9: ${okPat} (${res.error || ''})`);
    assert.ok(Number.isInteger(res.nfaStateCount) && res.nfaStateCount > 0, `Expected Thompson NFA compilation for: ${okPat}`);
    const input = '0'.repeat(4000) + '!';
    const tRun0 = performance.now();
    res.regex.test(input);
    const runMs = performance.now() - tRun0;
    assert.ok(runMs < 5, `Legitimate pattern "${okPat}" took ${runMs.toFixed(2)}ms on 4000-char input`);
  }

  // Thompson NFA semantic parity vs JS RegExp + input length cap check
  const parityCases = [
    ['^(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d]{8,32}$', ['Abcdef12', 'abcdef12', 'ABCDEF12', 'Abc123', 'A1b2C3d4E5']],
    ['^(?=a+)a+$', ['a', 'aaa', '', 'b', 'ab']],
    ['^(?!(?:admin|root)$)[a-z]+$', ['user', 'admin', 'root', 'admin1']],
    ['^(?m:^foo$)$', ['foo', 'bar\nfoo\nbaz']],
    ['(?m:^foo$)', ['bar\nfoo\nbaz', 'bar\nfoobar\nbaz']],
    ['^\\w{1,50}\\b\\W+\\b\\w{1,50}$', ['hello world', 'hello_world', 'a!b']],
    ['^(?:a1|b1|c1|d1|e1|f1|g1|h1|i1|j1|k1|l1|m1)+x(?:a1|b1|c1|d1|e1|f1|g1|h1|i1|j1|k1|l1|m1)+$', ['a1b1xc1d1', 'a1x', 'a1b1c1']],
    ['^(?:abcdefghijklmnopq)+x(?:abcdefghijklmnopq)+$', ['abcdefghijklmnopqxabcdefghijklmnopq', 'abcdefghijklmnopq']],
    ['^(?:ab?c?d?e?f?h)+x(?:ab?c?d?e?f?h)+$', ['ahxabfh', 'abcdefhxah', 'ah']],
    ['^(?:abc)+(?:ab)+$', ['abcabcab', 'abcabab', 'abc']],
    ['^(?:abc)+a(?:bc)$', ['abcabc', 'abc', 'abcb']],
    ['^(?:ab)+ab+$', ['abab', 'ababbb', 'ab', 'aba']],
    ['^(?:ab)+a(?:b)+$', ['abab', 'ababbb', 'ab', 'aba']],
  ];
  for (const [pat, samples] of parityCases) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected parity pattern valid: ${pat}`);
    const jsRe = new RegExp(pat);
    for (const sample of samples) {
      assert.equal(res.regex.test(sample), jsRe.test(sample), `Thompson NFA parity mismatch for ${pat} on ${JSON.stringify(sample)}`);
    }
  }
  const capped = validateSafeRegexPattern('^[a-z]+$');
  assert.throws(() => capped.regex.test('a'.repeat(4097)), { code: 'VALIDATION_PATTERN' });

  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 150, `R9 AST + Thompson NFA regex validation suite exceeded 150ms budget: ${elapsedMs.toFixed(2)}ms`);
});

test('Regression (M1.2 R10 Linear-Time Reverse-NFA Lookaheads, Surrogate-Pair Parity, Annex B Escapes, & BMP Case-Folding)', async () => {
  const { validateSafeRegexPattern, validateRecordFields } = require('../src/server/rich-schema');

  // 1. Quadratic lookahead probes must complete in < 20ms on 4096-char inputs (O(n * m) reverse NFA)
  const alphaBranches = Array.from({ length: 26 }, (_, i) => `[a-z]+${String.fromCharCode(65 + i)}`).join('|');
  const seqLookaheads = Array.from({ length: 21 }, (_, i) => `(?![a-z]+${String.fromCharCode(65 + i)})`).join('');
  const groupedLookaheads = [
    `(?!(?:${Array.from({ length: 6 }, (_, i) => `[a-z]+${String.fromCharCode(65 + i)}`).join('|')}))`,
    `(?!(?:${Array.from({ length: 6 }, (_, i) => `[a-z]+${String.fromCharCode(71 + i)}`).join('|')}))`,
    `(?!(?:${Array.from({ length: 6 }, (_, i) => `[a-z]+${String.fromCharCode(77 + i)}`).join('|')}))`,
    `(?!(?:${Array.from({ length: 6 }, (_, i) => `[a-z]+${String.fromCharCode(83 + i)}`).join('|')}))`,
  ].join('');
  const lookaheadProbes = [
    `^[a-z]*(?!(?:${alphaBranches}))Z$`,
    `(?!(?:${alphaBranches}))Z`,
    `${seqLookaheads}Z`,
    `${groupedLookaheads}Z`,
    '(?![a-z]+(?![a-z]+A)B)Z',
    '^[a-z]*(?=[a-z]+A)Z$',
    '[a-z]+(?=[a-z]+!)',
    '(?=[a-z]+(?=[a-z]+!))[a-z]+',
  ];
  const longInput = 'a'.repeat(4096);
  for (const pat of lookaheadProbes) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected lookahead probe valid: ${pat} (${res.error || ''})`);
    const tRun0 = performance.now();
    const out = res.regex.test(longInput);
    const runMs = performance.now() - tRun0;
    assert.equal(out, false, `Expected lookahead probe false on 'a'.repeat(4096): ${pat}`);
    assert.ok(runMs < 20, `Lookahead probe "${pat}" exceeded 20ms linear-time budget: ${runMs.toFixed(2)}ms`);
  }

  // Anchored validateRecordFields must also complete in < 20ms
  const anchoredPat = `^[a-z]*(?!(?:${alphaBranches}))Z$`;
  const tVal0 = performance.now();
  await assert.rejects(
    () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: anchoredPat } }], { code: longInput }),
    { code: 'VALIDATION_PATTERN' },
  );
  const valMs = performance.now() - tVal0;
  assert.ok(valMs < 20, `validateRecordFields on anchored lookahead exceeded 20ms: ${valMs.toFixed(2)}ms`);

  // Lookahead functional & nested/anchor parity vs JS RegExp
  const lookaheadParity = [
    [anchoredPat, ['Z', 'aZ', 'abA', 'abAZ', 'abZ']],
    ['(?![a-z]+(?![a-z]+A)B)Z', ['Z', 'aBZ', 'aABZ', 'aAB']],
    ['(?=[a-z]+(?=[a-z]+!))[a-z]+', ['abc!', 'abc', '!']],
    ['^a(?=^a|b)b', ['ab', 'aab']],
    ['foo (?=\\bbar\\b)bar', ['foo bar', 'foo barb', 'foobar']],
    ['^(?m:(?=^bar$)bar)$', ['bar', 'foo\nbar']],
    ['^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,32}$', ['Strong1!', 'weak1!', 'NoSpecial1', 'NOLOWER1!']],
  ];
  for (const [pat, samples] of lookaheadParity) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected lookahead parity pattern valid: ${pat}`);
    const jsRe = new RegExp(pat);
    for (const s of samples) {
      assert.equal(res.regex.test(s), jsRe.test(s), `Lookahead parity mismatch for ${pat} on ${JSON.stringify(s)}`);
    }
  }

  // 2. Non-BMP surrogate-pair parity (UTF-16 code units without /u)
  const surrogateParity = [
    ['^😀$', ['😀', '\ud83d', '\ude00', '😀😀', '']],
    ['^😀+$', ['😀', '😀😀', '😀\ude00', '😀\ude00\ude00', '\ud83d']],
    ['^😀{2}$', ['😀😀', '😀\ude00', '😀']],
    ['^(?:😀)+$', ['😀', '😀😀', '😀\ude00']],
    ['^[😀]$', ['\ud83d', '\ude00', '😀', 'a', '']],
    ['^[^😀]$', ['\ud83d', '\ude00', '😀', 'a', '']],
    ['^\\😀$', ['😀', '\ud83d\ude00', '\ude00', '\\😀']],
  ];
  for (const [pat, samples] of surrogateParity) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected surrogate pattern valid: ${pat} (${res.error || ''})`);
    const jsRe = new RegExp(pat);
    for (const s of samples) {
      assert.equal(res.regex.test(s), jsRe.test(s), `Surrogate parity mismatch for ${pat} on ${JSON.stringify(s)}`);
    }
  }
  assert.equal(validateSafeRegexPattern('^[😀-😃]$').valid, false, 'Out-of-order UTF-16 surrogate range [😀-😃] must reject like JS RegExp');

  // 3. Annex B \u{...} and \c parity without /u
  const annexBParity = [
    ['^\\u{61}$', ['a', 'u', 'u'.repeat(61), 'u'.repeat(60)]],
    ['^[\\u{61}]$', ['a', 'u', '{', '6', '1', '}']],
    ['^\\u{1F600}$', ['😀', 'u', 'u{1F600}']],
    ['^[\\u{1F600}]$', ['u', '{', '1', 'F', '6', '0', '0', '}', '😀']],
    ['^\\u{2,4}$', ['u', 'uu', 'uuu', 'uuuu', 'uuuuu']],
    ['^\\c$', ['\\c', 'c', '\\', '']],
    ['^\\c0$', ['\\c0', 'c0', '\x10']],
    ['^\\c+$', ['\\c', '\\cc', 'c', '\\']],
    ['^\\c{2}$', ['\\cc', '\\c\\c']],
    ['^[\\c0]$', ['\\', 'c', '0', '\x10']],
    ['^[\\c!]$', ['\\', 'c', '!', '\x01']],
    ['^[\\c-d]$', ['\\', 'c', '-', 'd']],
    ['^\\cA$', ['\x01', '\\cA']],
  ];
  for (const [pat, samples] of annexBParity) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected Annex B pattern valid: ${pat} (${res.error || ''})`);
    const jsRe = new RegExp(pat);
    for (const s of samples) {
      assert.equal(res.regex.test(s), jsRe.test(s), `Annex B parity mismatch for ${pat} on ${JSON.stringify(s)}`);
    }
  }

  // 4. Non-ASCII (?i:...) BMP case-folding parity (ECMA-262 toUpperCase equivalence classes)
  const caseFoldParity = [
    ['^(?i:\\u00df)$', ['\u00df', 'ẞ', 's', 'S']],
    ['^(?i:\\u03f4)$', ['\u03f4', 'θ', 'Θ']],
    ['^(?i:\\u2126)$', ['\u2126', 'ω', 'Ω']],
    ['^(?i:\\u017f)$', ['\u017f', 's', 'S']],
    ['^(?i:\\u212a)$', ['\u212a', 'k', 'K']],
    ['^(?i:\\u1f88)$', ['\u1f88', '\u1f80']],
  ];
  for (const [pat, samples] of caseFoldParity) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected case-fold pattern valid: ${pat}`);
    const jsRe = new RegExp(pat);
    for (const s of samples) {
      assert.equal(res.regex.test(s), jsRe.test(s), `Case-fold parity mismatch for ${pat} on ${JSON.stringify(s)}`);
    }
  }

  // Full 65,536-BMP sweep on all cased BMP code points
  let bmpDiffs = 0;
  for (let cp = 0x80; cp <= 0xFFFF; cp += 1) {
    const ch = String.fromCharCode(cp);
    const up = ch.toUpperCase();
    const low = ch.toLowerCase();
    if (up === ch && low === ch) continue;
    const hex = cp.toString(16).padStart(4, '0');
    const pat = `^(?i:\\u${hex})\\u1000$`;
    const res = validateSafeRegexPattern(pat);
    const jsRe = new RegExp(pat);
    const testTargets = new Set([cp]);
    if (up.length === 1) testTargets.add(up.charCodeAt(0));
    if (low.length === 1) testTargets.add(low.charCodeAt(0));
    for (const t of testTargets) {
      const sample = String.fromCharCode(t) + '\u1000';
      if (res.regex.test(sample) !== jsRe.test(sample)) {
        bmpDiffs += 1;
      }
    }
  }
  assert.equal(bmpDiffs, 0, `Expected 0 BMP case-folding parity mismatches, got ${bmpDiffs}`);
});

test('Regression (M1.2 R11 Lookahead Memoization & Cumulative NFA/Lookahead State Budget)', async () => {
  const { validateSafeRegexPattern, validateRecordFields } = require('../src/server/rich-schema');
  const longA = 'a'.repeat(4096);

  // 1. All 6 Challenger 10 adversarial lookahead patterns + Reviewer 10 probe:
  //    Each must either reject (valid: false) OR complete in < 20ms on 4096 chars (both test and validateRecordFields)
  const twentyBranches = Array.from({ length: 20 }, (_, i) => `[a${String.fromCharCode(98 + i)}]{1,100}`).join('|');
  const adversarialPatterns = [
    { name: 'c10_repeat_alt100_anchored', pat: `^(?:(?=(?:${'a|'.repeat(99)}a))a){1,100}Z$`, expectReject: true },
    { name: 'c10_repeat_alt100_unanchored', pat: `(?:(?=(?:${'a|'.repeat(99)}a))a){100}`, expectReject: true },
    { name: 'c10_repeat_nested_alt90', pat: `(?:(?=(?=(?:${'a|'.repeat(89)}a))a)a){1,100}`, expectReject: true },
    { name: 'c10_repeat_alt50_dedup_anchored', pat: `^(?:(?=(?:${'a|'.repeat(49)}a))a){1,100}Z$`, expectReject: false, expectMatch: false },
    { name: 'r10_repeat_34ab_la', pat: `(?:(?=${'(?:a|b)'.repeat(34)})a){1,100}`, expectReject: false, expectMatch: true },
    { name: 'c10_3982state_unanchored', pat: `(?=(?:${twentyBranches}))`, expectReject: true },
    { name: 'c10_3982state_anchored', pat: `^[a-z]*(?=(?:${twentyBranches}))Z$`, expectReject: true },
    { name: 'c10_4x_seq_large_lookahead', pat: `${'(?=(?:a{1,100}|[ab]{1,100}|[ac]{1,100}|[ad]{1,100}))'.repeat(4)}Z`, expectReject: true },
    { name: 'r10_repeat_240char_lookahead', pat: `(?:(?=${'a'.repeat(240)})a){1,100}`, expectReject: true },
  ];

  for (const item of adversarialPatterns) {
    const res = validateSafeRegexPattern(item.pat);
    if (item.expectReject) {
      assert.equal(res.valid, false, `Expected bloated lookahead "${item.name}" to reject`);
      await assert.rejects(
        () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: item.pat } }], { code: longA }),
        { code: 'INVALID_VALIDATION_PATTERN' },
      );
      continue;
    }
    assert.equal(res.valid, true, `Expected deduplicated lookahead "${item.name}" to stay valid (${res.error || ''})`);
    assert.ok(res.nfaStateCount <= 512, `Cumulative NFA states exceeded 512 for ${item.name}: ${res.nfaStateCount}`);
    const t0 = performance.now();
    const out = res.regex.test(longA);
    const testMs = performance.now() - t0;
    assert.equal(out, item.expectMatch, `Unexpected match result for ${item.name}`);
    assert.ok(testMs < 20, `${item.name} res.regex.test exceeded 20ms: ${testMs.toFixed(2)}ms`);

    const tv0 = performance.now();
    if (item.expectMatch) {
      await validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: item.pat } }], { code: longA });
    } else {
      await assert.rejects(
        () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: item.pat } }], { code: longA }),
        { code: 'VALIDATION_PATTERN' },
      );
    }
    const valMs = performance.now() - tv0;
    assert.ok(valMs < 20, `${item.name} validateRecordFields exceeded 20ms: ${valMs.toFixed(2)}ms`);
  }

  // 2. Lookahead deduplication in Repeat & syntactic reuse
  const dedupRepeat = validateSafeRegexPattern('^(?:(?=(?:a|b))a){1,100}$');
  assert.equal(dedupRepeat.valid, true, 'Expected Repeat-wrapped lookahead to stay valid');
  assert.equal(dedupRepeat.lookaheadCount, 1, `Expected 1 deduplicated lookahead, got ${dedupRepeat.lookaheadCount}`);
  assert.ok(dedupRepeat.lookaheadStateCount <= 10, `Expected <= 10 lookahead states, got ${dedupRepeat.lookaheadStateCount}`);
  assert.ok(dedupRepeat.nfaStateCount > 300 && dedupRepeat.nfaStateCount <= 350, `Expected cumulative nfaStateCount in (300, 350], got ${dedupRepeat.nfaStateCount}`);
  const jsDedupRe = /^(?:(?=(?:a|b))a){1,100}$/;
  for (const s of ['a', 'aa', 'a'.repeat(100), 'a'.repeat(101), 'b', 'ab', '']) {
    assert.equal(dedupRepeat.regex.test(s), jsDedupRe.test(s), `Deduplicated lookahead parity mismatch on ${JSON.stringify(s)}`);
  }
  const tDedup0 = performance.now();
  assert.equal(dedupRepeat.regex.test(longA), false);
  const dedupMs = performance.now() - tDedup0;
  assert.ok(dedupMs < 5, `Deduplicated ^(?:(?=(?:a|b))a){1,100}$ exceeded 5ms: ${dedupMs.toFixed(2)}ms`);

  // Positive + negative lookahead sharing identical body AST also shares 1 compiled subNfa
  const sharedPosNegPat = '^(?=(?:a|b))a(?=(?:a|b))a(?!(?:a|b))c$';
  const sharedPosNeg = validateSafeRegexPattern(sharedPosNegPat);
  assert.equal(sharedPosNeg.valid, true);
  assert.equal(sharedPosNeg.lookaheadCount, 1, 'Positive and negative lookahead with identical body should share 1 subNfa');
  const sharedPosNegJs = new RegExp(sharedPosNegPat);
  for (const s of ['aac', 'abc', 'aaa', 'abb', 'acc', '']) {
    assert.equal(sharedPosNeg.regex.test(s), sharedPosNegJs.test(s), `Shared pos/neg lookahead parity mismatch on ${JSON.stringify(s)}`);
  }

  // Flag-scoped deduplication: (?i:...) must not collide with non-ignoreCase lookahead cache entry
  const flagScopedPat = '^(?=(?:a|b))a(?i:(?=(?:a|b))b)$';
  const flagScoped = validateSafeRegexPattern(flagScopedPat);
  assert.equal(flagScoped.valid, true);
  assert.equal(flagScoped.lookaheadCount, 2, 'Lookahead with different inline flags must not reuse non-matching cache entry');
  assert.equal(flagScoped.regex.test('aB'), true);
  assert.equal(flagScoped.regex.test('Ab'), false);

  // 3. Exact boundary near MAX_TOTAL_LOOKAHEAD_STATES (120): accepted boundary < 20ms, over-cap rejected
  const atCap = validateSafeRegexPattern(`(?=${'a'.repeat(119)})`);
  assert.equal(atCap.valid, true, `Expected exact 120-state lookahead boundary valid (${atCap.error || ''})`);
  assert.equal(atCap.lookaheadStateCount, 120);
  const tCap0 = performance.now();
  assert.equal(atCap.regex.test(longA), true);
  const capMs = performance.now() - tCap0;
  assert.ok(capMs < 20, `Exact 120-state lookahead boundary exceeded 20ms: ${capMs.toFixed(2)}ms`);

  const overCap = validateSafeRegexPattern(`(?=${'a'.repeat(120)})`);
  assert.equal(overCap.valid, false, 'Expected 121-state lookahead (> MAX_TOTAL_LOOKAHEAD_STATES) to reject');

  // 4. Non-lookahead high-state regex (> MAX_NFA_STATES) rejects, while <= 512 remains valid;
  //    nfaStateCount reports cumulative root + lookahead states
  const nonLaTooLarge = validateSafeRegexPattern(`^(?:${twentyBranches})Z$`);
  assert.equal(nonLaTooLarge.valid, false, 'Expected 4003-state NFA (> MAX_NFA_STATES) to reject');

  const nonLaBoundary = validateSafeRegexPattern('^' + 'a{100}'.repeat(5) + 'Z$');
  assert.equal(nonLaBoundary.valid, true, `Expected anchored 504-state NFA (<= 512) to be valid (${nonLaBoundary.error || ''})`);
  assert.equal(nonLaBoundary.lookaheadCount, 0);
  assert.equal(nonLaBoundary.lookaheadStateCount, 0);
  assert.equal(nonLaBoundary.nfaStateCount, 504);

  const nonLaReject = validateSafeRegexPattern('^' + 'a{100}'.repeat(6) + '$');
  assert.equal(nonLaReject.valid, false);

  // Even when lookahead states <= 120, cumulative root + lookahead > MAX_NFA_STATES must reject
  const cumOverCap = validateSafeRegexPattern(`${'a{100}'.repeat(5)}(?=[ab]{1,20})`);
  assert.equal(cumOverCap.valid, false, 'Expected cumulative root + lookahead > MAX_NFA_STATES to reject');

  const cumCheck = validateSafeRegexPattern('^[a-z]*(?=[a-z]+A)Z$');
  assert.equal(cumCheck.valid, true);
  assert.equal(cumCheck.lookaheadCount, 1);
  assert.ok(cumCheck.lookaheadStateCount >= 4);
  assert.equal(cumCheck.nfaStateCount, 7 + cumCheck.lookaheadStateCount);
});

test('Regression (M1.2 R12 NFA Fast-Paths, Auto-Anchoring, Compile Cache, & Tightened Concurrency Budgets)', async () => {
  const { validateSafeRegexPattern, validateRecordFields, MAX_SAFE_REGEX_CACHE } = require('../src/server/rich-schema');
  assert.equal(MAX_SAFE_REGEX_CACHE, 256);
  const longA = 'a'.repeat(4096);

  // 1. All Challenger 11 unanchored / hybrid high-state patterns must reject cleanly (< 20ms if ever allowed)
  const twentyBranches = Array.from({ length: 20 }, (_, i) => `[a${String.fromCharCode(98 + i)}]{1,100}`).join('|');
  const nineteenBranches95 = Array.from({ length: 19 }, (_, i) => `[a${String.fromCharCode(98 + i)}]{1,95}`).join('|');
  const c11Rejected = [
    `(?:${twentyBranches})Z`,
    `^(?:${twentyBranches})Z$`,
    `(?:${nineteenBranches95}|[au]{1,95})Z`,
    `${'a{100}'.repeat(40)}Z`,
    `(?=[ab]{1,48})${'a{100}'.repeat(39)}`,
    `(?:${nineteenBranches95})(?=[ab]{1,99})Z`,
    `${'a{100}'.repeat(5)}Z`,
  ];
  for (const pat of c11Rejected) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, false, `Expected Challenger 11 bloated NFA pattern to reject: ${pat}`);
    await assert.rejects(
      () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: pat } }], { code: longA }),
      { code: 'INVALID_VALIDATION_PATTERN' },
    );
  }

  // 2. Unanchored boundary patterns (a{100}Z = 102 states, a{100}x3Z = 302 states) & dense CharClass lookahead <= 120 must run < 20ms
  const unanchoredBoundaries = [
    { name: 'unanchored_a100Z', pat: 'a{100}Z', expectMatch: false, expectedStates: 102 },
    { name: 'unanchored_a300Z', pat: `${'a{100}'.repeat(3)}Z`, expectMatch: false, expectedStates: 302 },
    { name: 'dense_cc_59_la118', pat: '(?=(?:[a-ac-ce-eg-gi-ik-km-mo-oq-qs-su-uw-wy-y0-02-24-46-68-8]){1,59})', expectMatch: true, expectedLaStates: 118 },
  ];
  for (const b of unanchoredBoundaries) {
    const tCompile0 = performance.now();
    const res = validateSafeRegexPattern(b.pat);
    assert.equal(res.valid, true, `Expected boundary pattern valid: ${b.name} (${res.error || ''})`);
    if (b.expectedStates !== undefined) assert.equal(res.nfaStateCount, b.expectedStates);
    if (b.expectedLaStates !== undefined) assert.equal(res.lookaheadStateCount, b.expectedLaStates);
    assert.equal(res.regex.test(longA), b.expectMatch);
    const totalMs = performance.now() - tCompile0;
    assert.ok(totalMs < 20, `${b.name} compile+test exceeded 20ms: ${totalMs.toFixed(2)}ms`);

    const tv0 = performance.now();
    if (b.expectMatch) {
      await validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: b.pat } }], { code: longA });
    } else {
      await assert.rejects(
        () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: b.pat } }], { code: longA }),
        { code: 'VALIDATION_PATTERN' },
      );
    }
    const valMs = performance.now() - tv0;
    assert.ok(valMs < 20, `${b.name} validateRecordFields exceeded 20ms: ${valMs.toFixed(2)}ms`);
  }

  // 2b. Fresh uncached validateRecordFields on unanchored pattern must also complete < 20ms
  const freshUncachedPat = `${'a{98}'.repeat(3)}Z`;
  const tFresh0 = performance.now();
  await assert.rejects(
    () => validateRecordFields(null, 'latticeCustomTest', [{ name: 'code', type: 'string', validation: { pattern: freshUncachedPat } }], { code: longA }),
    { code: 'VALIDATION_PATTERN' },
  );
  const freshValMs = performance.now() - tFresh0;
  assert.ok(freshValMs < 20, `Fresh uncached validateRecordFields exceeded 20ms: ${freshValMs.toFixed(2)}ms`);

  // 3. Automatic ^-anchoring fast-path & parity (must NOT mark (?m:^foo) or (?:^a|b) as anchoredAtStart)
  const anchorParity = [
    ['^foo$', ['foo', 'bar\nfoo', 'xfoo']],
    ['(?m:^foo)', ['foo', 'bar\nfoo', 'bar\nxfoo']],
    ['(?:^a|b)', ['a', 'xb', 'xa']],
    ['(?m:(?:^a|(?-m:^b)))', ['a', 'b', 'x\na', 'x\nb']],
    ['^(?m:foo)$', ['foo', 'foo\nbar', 'bar\nfoo']],
    ['^a|^b', ['a', 'b', 'xa', 'xb']],
    ['(?=a)^a', ['a', 'ba']],
    ['(?m:^a)(?-m:^b)', ['ab', 'x\nab', 'a\nb']],
  ];
  for (const [pat, samples] of anchorParity) {
    const res = validateSafeRegexPattern(pat);
    assert.equal(res.valid, true, `Expected anchor parity pattern valid: ${pat}`);
    const jsRe = new RegExp(pat);
    for (const s of samples) {
      assert.equal(res.regex.test(s), jsRe.test(s), `Auto-anchor parity mismatch for ${pat} on ${JSON.stringify(s)}`);
    }
  }
  const anchoredFailPat = '^(?:ab){1,100}Z$';
  const anchoredFailRes = validateSafeRegexPattern(anchoredFailPat);
  assert.equal(anchoredFailRes.valid, true);
  const tAnc0 = performance.now();
  assert.equal(anchoredFailRes.regex.test('b'.repeat(4096)), false);
  assert.equal(anchoredFailRes.regex.test('a'.repeat(4096)), false);
  const ancMs = performance.now() - tAnc0;
  assert.ok(ancMs < 2, `Auto-anchored ^ pattern took ${ancMs.toFixed(2)}ms on 4096-char mismatch`);

  // 4. Bounded compile cache returns clean unaliased objects & respects MAX_SAFE_REGEX_CACHE (256)
  const c1 = validateSafeRegexPattern('^cache_probe_[a-z]+$');
  const c2 = validateSafeRegexPattern('^cache_probe_[a-z]+$');
  assert.notEqual(c1, c2);
  assert.notEqual(c1.regex, c2.regex);
  c1.nfaStateCount = -999;
  c1.regex.flags = 'mutated';
  const c3 = validateSafeRegexPattern('^cache_probe_[a-z]+$');
  assert.ok(c3.nfaStateCount > 0);
  assert.equal(c3.regex.flags, '');
  for (let i = 0; i < MAX_SAFE_REGEX_CACHE + 40; i += 1) {
    const evictedCheck = validateSafeRegexPattern(`^cache_evict_${i}_[a-z]+$`);
    assert.equal(evictedCheck.valid, true);
  }
  const recompiled = validateSafeRegexPattern('^cache_probe_[a-z]+$');
  assert.equal(recompiled.valid, true);
  assert.equal(recompiled.regex.test('cache_probe_ok'), true);
});
