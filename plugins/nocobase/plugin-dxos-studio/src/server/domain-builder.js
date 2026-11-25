/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { loadFoundationSet } = require('./wms-dmn-shared');
const { upsertPortalPageForDomain } = require('./domain-portal-composer');
const {
  ALLOWED_FIELD_TYPES,
  ALLOWED_FORMULA_RETURN_TYPES,
  applyFormulaFields,
  attachAndVerifyPgRls,
  attachRichSchemaHooksForCollection,
  buildSafeJoinCollectionName,
  buildSafePgIndexName,
  createDomainAction,
  createOrUpdateDomainCollection,
  ensureBelongsToManyJoinCollection,
  evaluateFormulaExpression,
  listDomainsAction,
  mapFieldSpecToNocoBase,
  parseFormulaAst,
  parseRegexAst,
  registerRichSchemaHooks,
  resolveThroughCollectionName,
  sanitizeFieldValidation,
  sanitizeFields,
  validateFormulaExpression,
  validateRecordFields,
  validateSafeRegexPattern,
} = require('./domain-schema-rls');
const {
  createRequireBuilderAdmin,
  generateOrEnsureOrgPkiKey,
  listTenantsAction,
  provisionTenantAction,
} = require('./domain-tenant-provisioner');
const {
  BUSINESS_PACK_CATALOG,
  installBusinessPackAction,
  listBusinessPacksAction,
} = require('./domain-packs');

function createDxosBuilderActions(db, options = {}) {
  const foundation = options.foundation || loadFoundationSet();
  const requireBuilderAdmin = createRequireBuilderAdmin(db, foundation);

  return {
    listDomains(ctx, next) {
      return listDomainsAction(db, ctx, next, { requireBuilderAdmin });
    },
    createDomain(ctx, next) {
      return createDomainAction(db, ctx, next, { requireBuilderAdmin });
    },
    listBusinessPacks(ctx, next) {
      return listBusinessPacksAction(db, ctx, next, { foundation, requireBuilderAdmin });
    },
    installBusinessPack(ctx, next) {
      return installBusinessPackAction(db, ctx, next, { foundation, requireBuilderAdmin });
    },
    listTenants(ctx, next) {
      return listTenantsAction(db, ctx, next, { foundation, requireBuilderAdmin });
    },
    provisionTenant(ctx, next) {
      return provisionTenantAction(db, ctx, next, { foundation, options, requireBuilderAdmin });
    },
  };
}

module.exports = {
  ALLOWED_FIELD_TYPES,
  ALLOWED_FORMULA_RETURN_TYPES,
  BUSINESS_PACK_CATALOG,
  applyFormulaFields,
  attachAndVerifyPgRls,
  attachRichSchemaHooksForCollection,
  buildSafeJoinCollectionName,
  buildSafePgIndexName,
  createDxosBuilderActions,
  createOrUpdateDomainCollection,
  ensureBelongsToManyJoinCollection,
  evaluateFormulaExpression,
  generateOrEnsureOrgPkiKey,
  mapFieldSpecToNocoBase,
  parseFormulaAst,
  parseRegexAst,
  registerRichSchemaHooks,
  resolveThroughCollectionName,
  sanitizeFieldValidation,
  sanitizeFields,
  upsertPortalPageForDomain,
  validateFormulaExpression,
  validateRecordFields,
  validateSafeRegexPattern,
};
