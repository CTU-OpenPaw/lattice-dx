/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('crypto');
const { SYSTEM_PROTECTED_COLLECTIONS } = require('./solution-bundle');
const {
  CUSTOM_COLLECTION_RE,
  ALLOWLISTED_BUSINESS_COLLECTIONS,
} = require('./automation-engine');
const {
  fail,
  loadFoundationModule,
  readParams,
  toPlain,
  val,
} = require('./wms-dmn-shared');
const {
  ALLOWED_FIELD_TYPES,
  ALLOWED_FORMULA_RETURN_TYPES,
  BLOCKED_FIELD_NAMES,
  FIELD_NAME_RE,
  applyFormulaFields,
  attachRichSchemaHooksForCollection,
  buildSafeJoinCollectionName,
  evaluateFormulaExpression,
  parseFormulaAst,
  parseRegexAst,
  registerRichSchemaHooks,
  resolveThroughCollectionName,
  sanitizeFieldValidation,
  validateFormulaExpression,
  validateRecordFields,
  validateSafeRegexPattern,
} = require('./rich-schema');
const {
  DEFAULT_DOMAIN_ROLES,
  createBuilderApplyBlueprint,
  isEnterpriseBusinessRole,
  resolveExistingRolesSet,
  upsertPortalPageForDomain,
  upsertRepoRow,
} = require('./domain-portal-composer');

const DEFAULT_ROLE_ACTIONS = Object.freeze({
  ldx_admin: ['view', 'list', 'get', 'create', 'update', 'destroy'],
  ldx_manager: ['view', 'list', 'get', 'create', 'update'],
  ldx_operator: ['view', 'list', 'get', 'create', 'update'],
  ldx_employee: ['view', 'list', 'get', 'create'],
});

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoFieldPrototypePollution(value, pathPrefix = 'fields', depth = 0) {
  if (depth > 24) {
    throw fail('PAYLOAD_DEPTH_EXCEEDED', 400, `Field specification exceeds maximum depth at ${pathPrefix}`);
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoFieldPrototypePollution(value[i], `${pathPrefix}[${i}]`, depth + 1);
    }
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      throw fail(
        'PROTOTYPE_POLLUTION_FORBIDDEN',
        400,
        `Forbidden prototype key "${key}" at ${pathPrefix}`,
      );
    }
    assertNoFieldPrototypePollution(value[key], `${pathPrefix}.${key}`, depth + 1);
  }
  return value;
}

function buildSafePgIndexName(collectionName, suffix = 'org') {
  const cleanCol = String(collectionName || '').replace(/[^A-Za-z0-9_]/g, '');
  const candidate = `idx_${cleanCol}_${suffix}`;
  if (candidate.length <= 63) return candidate;
  const hash = crypto.createHash('sha256').update(cleanCol).digest('hex').slice(0, 8);
  const maxPrefix = 63 - 5 - hash.length - suffix.length;
  return `idx_${cleanCol.slice(0, Math.max(8, maxPrefix))}_${hash}_${suffix}`;
}

function mapFieldSpecToNocoBase(field) {
  const type = String(field.type || 'string');
  const name = String(field.name || '').trim();
  const title = String(field.title || name).trim();
  const required = Boolean(field.required || field.validation?.required);
  const allowNull = !required;

  const base = {
    name,
    type,
    allowNull,
    interface: 'input',
    uiSchema: {
      title,
      type: 'string',
      'x-component': 'Input',
    },
  };

  if (type === 'text') {
    base.interface = 'textarea';
    base.uiSchema['x-component'] = 'Input.TextArea';
  } else if (type === 'integer') {
    base.interface = 'integer';
    base.uiSchema.type = 'number';
    base.uiSchema['x-component'] = 'InputNumber';
  } else if (type === 'float') {
    base.interface = 'number';
    base.uiSchema.type = 'number';
    base.uiSchema['x-component'] = 'InputNumber';
  } else if (type === 'boolean') {
    base.interface = 'checkbox';
    base.uiSchema.type = 'boolean';
    base.uiSchema['x-component'] = 'Checkbox';
  } else if (type === 'date') {
    base.interface = 'date';
    base.uiSchema['x-component'] = 'DatePicker';
  } else if (type === 'datetime') {
    base.interface = 'datetime';
    base.uiSchema['x-component'] = 'DatePicker';
    base.uiSchema['x-component-props'] = { showTime: true };
  } else if (type === 'json') {
    base.type = 'jsonb';
    base.interface = 'json';
    base.uiSchema.type = 'object';
    base.uiSchema['x-component'] = 'Input.JSON';
  } else if (type === 'belongsTo') {
    base.interface = 'obo';
    base.target = String(field.target || '').trim();
    base.foreignKey = String(field.foreignKey || `${name}Id`).trim();
    base.uiSchema.type = 'object';
    base.uiSchema['x-component'] = 'AssociationField';
  } else if (type === 'hasOne') {
    base.interface = 'oho';
    base.target = String(field.target || '').trim();
    base.foreignKey = String(field.foreignKey || `${name}Id`).trim();
    base.sourceKey = String(field.sourceKey || 'id').trim();
    base.uiSchema.type = 'object';
    base.uiSchema['x-component'] = 'AssociationField';
  } else if (type === 'belongsToMany') {
    base.interface = 'm2m';
    base.target = String(field.target || '').trim();
    base.through = String(field.through || '').trim();
    base.foreignKey = String(field.foreignKey || '').trim();
    base.otherKey = String(field.otherKey || '').trim();
    base.sourceKey = String(field.sourceKey || 'id').trim();
    base.targetKey = String(field.targetKey || 'id').trim();
    base.uiSchema.type = 'array';
    base.uiSchema['x-component'] = 'AssociationField';
  } else if (type === 'formula') {
    const returnType = ALLOWED_FORMULA_RETURN_TYPES.has(field.formulaReturnType)
      ? field.formulaReturnType
      : 'float';
    const formulaExpr = String(field.formulaExpression || field.formula || '').trim();
    base.type = returnType;
    base.interface = 'formula';
    base.readOnly = true;
    base.formula = formulaExpr;
    base.formulaExpression = formulaExpr;
    base.formulaReturnType = returnType;
    base.options = {
      ...(base.options || {}),
      formula: formulaExpr,
      formulaExpression: formulaExpr,
      formulaReturnType: returnType,
      readOnly: true,
    };
    base.uiSchema.type = returnType === 'boolean' ? 'boolean' : returnType === 'string' ? 'string' : 'number';
    base.uiSchema['x-component'] = returnType === 'boolean'
      ? 'Checkbox'
      : returnType === 'string'
        ? 'Input'
        : 'InputNumber';
    base.uiSchema['x-read-pretty'] = true;
    base.uiSchema.readOnly = true;
    base.uiSchema['x-formula'] = formulaExpr;
  } else if (Array.isArray(field.enumValues) && field.enumValues.length > 0) {
    base.interface = 'select';
    base.uiSchema.enum = field.enumValues.map((v) => ({ value: String(v), label: String(v) }));
    base.uiSchema['x-component'] = 'Select';
  }

  if (field.validation && typeof field.validation === 'object') {
    // Store Lattice rich-schema validation only in uiSchema['x-validation'] so NocoBase's
    // Joi field-validation compiler does not crash on non-Joi validation objects.
    base.uiSchema['x-validation'] = field.validation;
    if (Array.isArray(field.validation.enum) && field.validation.enum.length > 0 && !base.uiSchema.enum) {
      base.interface = 'select';
      base.uiSchema.enum = field.validation.enum.map((v) => ({ value: String(v), label: String(v) }));
      base.uiSchema['x-component'] = 'Select';
    }
  }

  if (field.indexed) {
    base.index = true;
  }
  return base;
}

function sanitizeFields(rawFields, opts = {}) {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw fail('INVALID_FIELDS', 400, 'fields must be a non-empty array');
  }
  const sourceCollection = String(opts.collectionName || 'latticeCustomDomain').trim();
  const seen = new Set();
  const sanitized = [];
  for (let i = 0; i < rawFields.length; i += 1) {
    const f = rawFields[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw fail('INVALID_FIELD', 400, `fields[${i}] must be an object`);
    }
    assertNoFieldPrototypePollution(f, `fields[${i}]`);
    const name = String(f.name || '').trim();
    if (!FIELD_NAME_RE.test(name) || BLOCKED_FIELD_NAMES.has(name)) {
      throw fail('INVALID_FIELD_NAME', 400, `Invalid field name "${name || '(empty)'}" at fields[${i}]`);
    }
    if (name === 'organizationId') continue;
    if (seen.has(name)) {
      throw fail('DUPLICATE_FIELD_NAME', 400, `Duplicate field name "${name}"`);
    }
    seen.add(name);
    const type = String(f.type || 'string').trim();
    if (!ALLOWED_FIELD_TYPES.has(type)) {
      throw fail('INVALID_FIELD_TYPE', 400, `Unsupported field type "${type}" on field "${name}"`);
    }

    let target = null;
    let foreignKey = null;
    let otherKey = null;
    let through = null;
    let formulaExpression = null;
    let formulaReturnType = null;

    if (type === 'belongsTo' || type === 'hasOne') {
      target = String(f.target || '').trim();
      const targetAllowed = CUSTOM_COLLECTION_RE.test(target) || ALLOWLISTED_BUSINESS_COLLECTIONS.has(target);
      const errCode = type === 'hasOne' ? 'INVALID_HAS_ONE_TARGET' : 'INVALID_BELONGS_TO_TARGET';
      if (!target || SYSTEM_PROTECTED_COLLECTIONS.has(target) || !targetAllowed) {
        throw fail(errCode, 400, `Disallowed ${type} target "${target || '(empty)'}" on field "${name}"`);
      }
      if (f.foreignKey !== undefined && f.foreignKey !== null) {
        if (typeof f.foreignKey !== 'string') {
          throw fail('INVALID_FOREIGN_KEY', 400, `Invalid foreignKey on field "${name}"`);
        }
        foreignKey = f.foreignKey.trim();
      } else {
        foreignKey = `${name}Id`;
      }
      if (!FIELD_NAME_RE.test(foreignKey) || BLOCKED_FIELD_NAMES.has(foreignKey) || foreignKey === 'organizationId') {
        throw fail('INVALID_FOREIGN_KEY', 400, `Invalid foreignKey "${foreignKey || '(empty)'}" on field "${name}"`);
      }
    } else if (type === 'belongsToMany') {
      target = String(f.target || '').trim();
      const targetAllowed = CUSTOM_COLLECTION_RE.test(target) || ALLOWLISTED_BUSINESS_COLLECTIONS.has(target);
      if (!target || SYSTEM_PROTECTED_COLLECTIONS.has(target) || !targetAllowed) {
        throw fail('INVALID_BELONGS_TO_MANY_TARGET', 400, `Disallowed belongsToMany target "${target || '(empty)'}" on field "${name}"`);
      }
      ({ through, foreignKey, otherKey } = resolveThroughCollectionName(sourceCollection, { ...f, name, target }, {
        isProtectedCollection: (col) => SYSTEM_PROTECTED_COLLECTIONS.has(col),
      }));
    } else if (type === 'formula') {
      const rawExpr = f.formulaExpression !== undefined ? f.formulaExpression : f.formula;
      const formulaCheck = validateFormulaExpression(rawExpr, { selfFieldName: name });
      if (!formulaCheck.valid) {
        throw fail(formulaCheck.code || 'INVALID_FORMULA_EXPRESSION', 400, formulaCheck.error);
      }
      formulaExpression = String(rawExpr).trim();
      if (f.formulaReturnType !== undefined && f.formulaReturnType !== null) {
        const rt = String(f.formulaReturnType).trim();
        if (!ALLOWED_FORMULA_RETURN_TYPES.has(rt)) {
          throw fail('INVALID_FORMULA_RETURN_TYPE', 400, `Invalid formulaReturnType "${rt}" on field "${name}"`);
        }
        formulaReturnType = rt;
      } else {
        formulaReturnType = formulaCheck.inferredReturnType || 'float';
      }
    }

    const enumValues = Array.isArray(f.enumValues)
      ? f.enumValues.map((v) => String(v).trim()).filter(Boolean).slice(0, 50)
      : undefined;
    const validation = sanitizeFieldValidation({
      ...f,
      name,
      type,
      ...(formulaReturnType ? { formulaReturnType } : {}),
      ...(enumValues ? { enumValues } : {}),
    });

    sanitized.push({
      name,
      type,
      title: f.title ? String(f.title).trim() : name,
      required: Boolean(f.required || validation?.required),
      indexed: Boolean(f.indexed),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      ...(validation ? { validation } : {}),
      ...(target ? { target, foreignKey } : {}),
      ...(through ? { through, otherKey } : {}),
      ...(formulaExpression ? { formula: formulaExpression, formulaExpression, formulaReturnType } : {}),
    });
  }
  return sanitized;
}

async function attachAndVerifyPgRls(db, collectionName, opts = {}) {
  let attached = false;
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    await db.attachLatticeRlsPolicy(collectionName);
    attached = true;
  } else {
    const pgRls = opts.pgRls !== undefined ? opts.pgRls : loadFoundationModule('pg-rls');
    if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
      await pgRls.attachRlsPolicyToTable(db, collectionName);
      attached = true;
    } else if (db?.sequelize && typeof db.sequelize.query === 'function') {
      const dialect = typeof db.sequelize.getDialect === 'function' ? db.sequelize.getDialect() : 'postgres';
      if (dialect === 'postgres') {
        const safeTable = String(collectionName).replace(/[^A-Za-z0-9_]/g, '');
        if (!safeTable) {
          throw fail('INVALID_COLLECTION_NAME', 400, 'Invalid collectionName for RLS policy');
        }
        const predicate = [
          "current_setting('app.rls_bypass', true) = 'on'",
          "current_setting('app.current_org', true) = '*'",
          '"organizationId" = nullif(current_setting(\'app.current_org\', true), \'\')',
        ].join(' OR ');
        await db.sequelize.query(`ALTER TABLE "${safeTable}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${safeTable}" FORCE ROW LEVEL SECURITY;`);
        await db.sequelize.query(`DROP POLICY IF EXISTS "lattice_tenant_isolation" ON "${safeTable}"`);
        await db.sequelize.query(
          `CREATE POLICY "lattice_tenant_isolation" ON "${safeTable}" AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate})`,
        );
        attached = true;
      }
    }
  }

  let verified = attached;
  const dialect = typeof db?.sequelize?.getDialect === 'function' ? db.sequelize.getDialect() : null;
  if (dialect === 'postgres' && typeof db?.sequelize?.query === 'function') {
    const res = await db.sequelize.query(
      'SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = :tableName LIMIT 1',
      { replacements: { tableName: collectionName } },
    );
    const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : Array.isArray(res) ? res : [];
    if (rows.length > 0) {
      const row = rows[0];
      if (row && (row.rls_enabled === false || row.rls_forced === false)) {
        throw fail('PG_RLS_VERIFICATION_FAILED', 500, `PostgreSQL RLS could not be verified on ${collectionName}`);
      }
      if (row && row.rls_enabled === true && row.rls_forced !== false) {
        verified = true;
      }
    }
  }

  if (dialect === 'postgres' && !verified) {
    throw fail('PG_RLS_NOT_ATTACHED', 500, `Unable to attach tenant RLS policy on ${collectionName}`);
  }
  return { attached, verified };
}

function buildActionFieldsList(fields) {
  const baseCols = ['id', 'createdAt', 'updatedAt', 'organizationId'];
  const extraCols = (Array.isArray(fields) ? fields : [])
    .map((f) => (f?.type === 'belongsTo' ? String(f.foreignKey || `${f.name}Id`).trim() : String(f?.name || '').trim()))
    .filter(Boolean);
  return [...new Set([...baseCols, ...extraCols])];
}

async function grantDomainRbac(db, collectionName, roleNames, fields = [], ctx = null) {
  const requestedRoles = (Array.isArray(roleNames) && roleNames.length ? roleNames : DEFAULT_DOMAIN_ROLES)
    .map((r) => String(r || '').trim())
    .filter((r) => isEnterpriseBusinessRole(r));
  const existingRoles = await resolveExistingRolesSet(db);
  const rolesToGrant = existingRoles ? requestedRoles.filter((r) => existingRoles.has(r)) : requestedRoles;

  const dsRolesRepo = db.getRepository?.('dataSourcesRoles');
  const dsResourcesRepo = db.getRepository?.('dataSourcesRolesResources');
  const dsActionsRepo = db.getRepository?.('dataSourcesRolesResourcesActions');
  const legacyResRepo = db.getRepository?.('rolesResources');
  const viewFields = buildActionFieldsList(fields);
  const writeFields = viewFields.filter((f) => f !== 'id' && f !== 'createdAt' && f !== 'updatedAt');
  const grantedRoles = [];

  for (const roleName of rolesToGrant) {
    if (dsRolesRepo) {
      await upsertRepoRow(
        dsRolesRepo,
        { roleName, dataSourceKey: 'main' },
        { roleName, dataSourceKey: 'main' },
      );
    }
    let resRow = null;
    if (dsResourcesRepo) {
      resRow = await upsertRepoRow(
        dsResourcesRepo,
        { roleName, dataSourceKey: 'main', name: collectionName },
        {
          roleName,
          dataSourceKey: 'main',
          name: collectionName,
          usingActionsConfig: true,
        },
      );
    } else if (legacyResRepo) {
      resRow = await upsertRepoRow(
        legacyResRepo,
        { roleName, name: collectionName },
        { roleName, name: collectionName, usingActionsConfig: true },
      );
    }
    const rolesResourceId = val(resRow, 'id') ?? null;
    if (dsActionsRepo && rolesResourceId != null) {
      const actions = DEFAULT_ROLE_ACTIONS[roleName] || ['view', 'list', 'get'];
      for (const actionName of actions) {
        const actionFields = ['create', 'update'].includes(actionName) ? writeFields : viewFields;
        await upsertRepoRow(
          dsActionsRepo,
          { rolesResourceId, name: actionName },
          {
            rolesResourceId,
            name: actionName,
            ...(actionFields.length ? { fields: actionFields } : {}),
          },
        );
      }
    }
    grantedRoles.push(roleName);
  }
  if (typeof ctx?.app?.acl?.writeRolesToACL === 'function') {
    try {
      await ctx.app.acl.writeRolesToACL();
    } catch {
      // Non-fatal: DB ACL rows already persisted
    }
  }
  return grantedRoles;
}

async function syncCollectionWithSafeRls(db, collectionDef, expectedColumns, indexCreates = []) {
  const collectionName = collectionDef.name;
  const isPgWithQuery = Boolean(
    db?.sequelize
    && typeof db.sequelize.query === 'function'
    && (typeof db.sequelize.getDialect !== 'function' || db.sequelize.getDialect() === 'postgres'),
  );
  let rlsDroppedForAlter = false;
  let registered = null;
  if (typeof db.collection === 'function') {
    registered = db.collection(collectionDef);
    if (registered?.fields && typeof registered.fields.values === 'function') {
      for (const memField of registered.fields.values()) {
        const memVal = memField?.options?.validation;
        if (memVal && typeof memVal === 'object' && typeof memVal.type !== 'string') {
          delete memField.options.validation;
        }
      }
    }
    if (registered && typeof registered.sync === 'function') {
      let existingCols = new Set();
      if (isPgWithQuery) {
        const colRes = await db.sequelize.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = :tableName',
          { replacements: { tableName: collectionName } },
        ).catch(() => [[], []]);
        const colRows = Array.isArray(colRes) && Array.isArray(colRes[0]) ? colRes[0] : Array.isArray(colRes) ? colRes : [];
        existingCols = new Set(colRows.map((row) => String(row?.column_name || '').trim()).filter(Boolean));
      }

      if (existingCols.size === 0) {
        await registered.sync({ alter: true });
      } else if (expectedColumns.every((col) => existingCols.has(col))) {
        await registered.sync();
      } else {
        // Keep RLS enabled (fail-closed) and temporarily drop only the policy referencing organizationId during column DDL.
        await db.sequelize.query(`DROP POLICY IF EXISTS "lattice_tenant_isolation" ON "${collectionName}"`);
        rlsDroppedForAlter = true;
        try {
          await registered.sync({ alter: true });
        } finally {
          await attachAndVerifyPgRls(db, collectionName);
          rlsDroppedForAlter = false;
        }
      }
    }
  }
  if (typeof db.sync === 'function' && !rlsDroppedForAlter) {
    await db.sync();
  }
  if (registered && typeof db.emitAsync === 'function') {
    await db.emitAsync('collection:loaded', { collection: registered }).catch(() => {});
  }
  if (isPgWithQuery) {
    for (const sql of indexCreates) {
      await db.sequelize.query(sql).catch(() => {});
    }
  }
  return registered;
}

async function ensureBelongsToManyJoinCollection(db, { sourceCollection, field, roles, ctx = null }) {
  const joinName = String(field.through || '').trim();
  if (!CUSTOM_COLLECTION_RE.test(joinName) || SYSTEM_PROTECTED_COLLECTIONS.has(joinName)) {
    throw fail('INVALID_THROUGH_COLLECTION', 400, `Invalid belongsToMany through collection "${joinName}"`);
  }
  const fk = String(field.foreignKey || '').trim();
  const ok = String(field.otherKey || '').trim();
  const joinFieldsSpec = [
    { name: 'organizationId', type: 'string', allowNull: false, index: true },
    { name: fk, type: 'bigInt', allowNull: false, index: true },
    { name: ok, type: 'bigInt', allowNull: false, index: true },
  ];
  const collectionsRepo = db.getRepository?.('collections');
  const fieldsRepo = db.getRepository?.('fields');

  if (collectionsRepo) {
    await upsertRepoRow(
      collectionsRepo,
      { name: joinName },
      {
        name: joinName,
        title: `${sourceCollection} -> ${field.target} Join`,
        createdAt: true,
        updatedAt: true,
        autoGenId: true,
        logging: true,
      },
    );
  }
  if (fieldsRepo) {
    for (const fSpec of joinFieldsSpec) {
      await upsertRepoRow(
        fieldsRepo,
        { collectionName: joinName, name: fSpec.name },
        { collectionName: joinName, ...fSpec },
      );
    }
  }

  const orgIdx = buildSafePgIndexName(joinName, 'org');
  const fkIdx = buildSafePgIndexName(joinName, 'fk');
  const okIdx = buildSafePgIndexName(joinName, 'ok');
  const uqIdx = buildSafePgIndexName(joinName, 'uq');

  await syncCollectionWithSafeRls(
    db,
    {
      name: joinName,
      title: `${sourceCollection} -> ${field.target} Join`,
      autoGenId: true,
      logging: true,
      loadedFromCollectionManager: true,
      timestamps: true,
      createdAt: true,
      updatedAt: true,
      fields: joinFieldsSpec,
      indexes: [
        { name: orgIdx, fields: ['organizationId'] },
        { name: fkIdx, fields: [fk] },
        { name: okIdx, fields: [ok] },
        { name: uqIdx, unique: true, fields: ['organizationId', fk, ok] },
      ],
    },
    ['organizationId', fk, ok],
    [
      `CREATE INDEX IF NOT EXISTS "${orgIdx}" ON "${joinName}" ("organizationId")`,
      `CREATE INDEX IF NOT EXISTS "${fkIdx}" ON "${joinName}" ("${fk}")`,
      `CREATE INDEX IF NOT EXISTS "${okIdx}" ON "${joinName}" ("${ok}")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "${uqIdx}" ON "${joinName}" ("organizationId", "${fk}", "${ok}")`,
    ],
  );

  const rls = await attachAndVerifyPgRls(db, joinName);
  const grantedRoles = await grantDomainRbac(db, joinName, roles, joinFieldsSpec, ctx);
  return {
    collectionName: joinName,
    foreignKey: fk,
    otherKey: ok,
    rls,
    grantedRoles,
    indexes: [orgIdx, fkIdx, okIdx, uqIdx],
  };
}

async function createOrUpdateDomainCollection(db, params, opts = {}) {
  const collectionName = String(params.collectionName || '').trim();
  if (!CUSTOM_COLLECTION_RE.test(collectionName)) {
    throw fail('INVALID_COLLECTION_NAME', 400, `collectionName must match ${CUSTOM_COLLECTION_RE.source}`);
  }
  if (SYSTEM_PROTECTED_COLLECTIONS.has(collectionName)) {
    throw fail('SYSTEM_COLLECTION_FORBIDDEN', 400, `${collectionName} is a protected system table`);
  }

  const sanitizedFields = sanitizeFields(params.fields, { collectionName });
  const title = String(params.title || collectionName).trim();
  const description = params.description ? String(params.description).trim() : null;
  const firstStringField = sanitizedFields.find((f) => f && f.name && ['string', 'text'].includes(f.type));
  const titleField = firstStringField ? firstStringField.name : null;
  const fullFieldsSpec = [
    { name: 'organizationId', type: 'string', allowNull: false, index: true },
    ...sanitizedFields.map(mapFieldSpecToNocoBase),
  ];

  const collectionsRepo = db.getRepository?.('collections');
  const fieldsRepo = db.getRepository?.('fields');

  if (collectionsRepo) {
    await upsertRepoRow(
      collectionsRepo,
      { name: collectionName },
      {
        name: collectionName,
        title,
        description,
        createdAt: true,
        updatedAt: true,
        autoGenId: true,
        logging: true,
        ...(titleField ? { titleField } : {}),
      },
    );
  }

  if (fieldsRepo) {
    for (const fSpec of fullFieldsSpec) {
      const existingField = typeof fieldsRepo.findOne === 'function'
        ? await fieldsRepo.findOne({ filter: { collectionName, name: fSpec.name } })
        : null;
      const existingVal = existingField?.options?.validation;
      const clearLegacyValidation = Boolean(
        existingVal && typeof existingVal === 'object' && typeof existingVal.type !== 'string',
      );
      await upsertRepoRow(
        fieldsRepo,
        { collectionName, name: fSpec.name },
        {
          collectionName,
          ...fSpec,
          ...(clearLegacyValidation ? { validation: null } : {}),
        },
      );
    }
  }

  // Provision, sync, index, and RLS-protect all belongsToMany `through` join collections BEFORE
  // syncing the main collection so Sequelize/NocoBase never auto-creates an un-RLSed join table.
  const joinCollections = [];
  for (const field of sanitizedFields) {
    if (field.type === 'belongsToMany') {
      const joinInfo = await ensureBelongsToManyJoinCollection(db, {
        sourceCollection: collectionName,
        field,
        roles: params.roles,
        ctx: opts.ctx || null,
      });
      joinCollections.push(joinInfo);
    }
  }

  const indexName = buildSafePgIndexName(collectionName, 'org');
  const expectedColumns = [
    'organizationId',
    ...sanitizedFields
      .filter((f) => f.type !== 'hasOne' && f.type !== 'belongsToMany')
      .map((f) => (f.type === 'belongsTo' ? String(f.foreignKey || `${f.name}Id`).trim() : f.name)),
  ];

  await syncCollectionWithSafeRls(
    db,
    {
      name: collectionName,
      title,
      description,
      autoGenId: true,
      logging: true,
      loadedFromCollectionManager: true,
      ...(titleField ? { titleField } : {}),
      timestamps: true,
      createdAt: true,
      updatedAt: true,
      fields: fullFieldsSpec,
      indexes: [{ name: indexName, fields: ['organizationId'] }],
    },
    expectedColumns,
    [`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${collectionName}" ("organizationId")`],
  );

  const rls = await attachAndVerifyPgRls(db, collectionName);
  const grantedRoles = await grantDomainRbac(db, collectionName, params.roles, sanitizedFields, opts.ctx || null);

  attachRichSchemaHooksForCollection(db, collectionName, sanitizedFields);

  let portalPage = null;
  if (params.portalSlug) {
    portalPage = await upsertPortalPageForDomain(db, {
      slug: params.portalSlug,
      title: params.portalTitle || title,
      collectionName,
      roleNames: grantedRoles,
      fields: sanitizedFields,
      applyBlueprint: opts.applyBlueprint || createBuilderApplyBlueprint(opts.ctx),
    });
  }

  return {
    collectionName,
    title,
    fields: sanitizedFields,
    indexName,
    rls,
    grantedRoles,
    ...(joinCollections.length ? { joinCollections } : {}),
    portalPage,
  };
}

async function listDomainsAction(db, ctx, next, { requireBuilderAdmin }) {
  const params = readParams(ctx);
  await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: false, patScopes: ['read', 'write'] });

  const collectionsRepo = db.getRepository?.('collections');
  const fieldsRepo = db.getRepository?.('fields');
  const routesRepo = db.getRepository?.('desktopRoutes');

  const colMap = new Map();
  if (collectionsRepo) {
    const rows = await collectionsRepo.find({ limit: 500 });
    for (const r of Array.isArray(rows) ? rows : []) {
      const plain = toPlain(r);
      if (CUSTOM_COLLECTION_RE.test(String(plain?.name || ''))) {
        colMap.set(plain.name, plain);
      }
    }
  }
  if (db.collections && typeof db.collections.entries === 'function') {
    for (const [name] of db.collections.entries()) {
      if (CUSTOM_COLLECTION_RE.test(String(name)) && !colMap.has(name)) {
        colMap.set(name, { name, title: name });
      }
    }
  }

  const routeRows = routesRepo ? await routesRepo.find({ limit: 500 }) : [];
  const routes = (Array.isArray(routeRows) ? routeRows : []).map(toPlain);

  const items = [];
  for (const [name, meta] of colMap.entries()) {
    let fields = [];
    if (fieldsRepo) {
      const fRows = await fieldsRepo.find({ filter: { collectionName: name }, limit: 200 });
      fields = (Array.isArray(fRows) ? fRows : []).map(toPlain);
    } else if (typeof db.getCollection === 'function') {
      const col = db.getCollection(name);
      if (col?.fields) {
        fields = Array.from(col.fields.values()).map((f) => ({
          name: f.name,
          type: f.type,
        }));
      }
    }
    const boundRoutes = routes
      .filter((r) => r?.options?.collectionName === name)
      .map((r) => ({ id: r.id, title: r.title, path: r.options?.path || null, schemaUid: r.schemaUid }));

    items.push({
      collectionName: name,
      title: meta.title || name,
      description: meta.description || null,
      rlsProtected: true,
      fields,
      portalPages: boundRoutes,
    });
  }
  ctx.body = { items };
  return next();
}

async function createDomainAction(db, ctx, next, { requireBuilderAdmin }) {
  const params = readParams(ctx);
  await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: true, patScopes: ['write'] });
  const domain = await createOrUpdateDomainCollection(db, params, {
    ctx,
    applyBlueprint: createBuilderApplyBlueprint(ctx),
  });
  ctx.body = { domain };
  return next();
}

module.exports = {
  ALLOWED_FIELD_TYPES,
  ALLOWED_FORMULA_RETURN_TYPES,
  DEFAULT_ROLE_ACTIONS,
  FORBIDDEN_PROTO_KEYS,
  applyFormulaFields,
  assertNoFieldPrototypePollution,
  attachAndVerifyPgRls,
  attachRichSchemaHooksForCollection,
  buildActionFieldsList,
  buildSafeJoinCollectionName,
  buildSafePgIndexName,
  createDomainAction,
  createOrUpdateDomainCollection,
  ensureBelongsToManyJoinCollection,
  evaluateFormulaExpression,
  grantDomainRbac,
  listDomainsAction,
  mapFieldSpecToNocoBase,
  parseFormulaAst,
  parseRegexAst,
  registerRichSchemaHooks,
  resolveThroughCollectionName,
  sanitizeFieldValidation,
  sanitizeFields,
  syncCollectionWithSafeRls,
  validateFormulaExpression,
  validateRecordFields,
  validateSafeRegexPattern,
};
