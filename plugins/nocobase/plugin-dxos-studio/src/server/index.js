/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { Plugin } = require('@nocobase/server');
const { validateServiceTicket } = require('./service-schema');
const { createServiceScopeMiddleware } = require('./service-scope');
const { createDxosStudioActions } = require('./studio-resource');
const {
  WMS_DMN_COLLECTIONS,
  createDxosWmsActions,
  createWmsDmnDirectGuardMiddleware,
  validateTenantCollectionRecord,
} = require('./wms-engine');
const { createDxosDmnActions } = require('./dmn-engine');
const { createDxosDelegationsActions } = require('./delegation-engine');
const {
  createAutomationDirectGuardMiddleware,
  createDxosAutomationsActions,
  registerAutomationEventListener,
  registerRecordTriggerHooks,
} = require('./automation-engine');
const { tickFlowScheduler } = require('./flow/cron');
const { createDxosBuilderActions } = require('./domain-builder');
const {
  evaluateFormulaExpression,
  parseFormulaAst,
  registerRichSchemaHooks,
  validateFormulaExpression,
  validateSafeRegexPattern,
} = require('./rich-schema');
const { createN8nRouteHandlers } = require('./n8n-api-client');
const { fail, readParams, resolveVerifiedRoles } = require('./wms-dmn-shared');

function createOrganizationDirectGuardMiddleware(db) {
  return async function dxosOrganizationDirectGuard(ctx, next) {
    const resourceName = String(ctx?.action?.resourceName || '').trim();
    const baseResource = resourceName.split('.')[0];
    const actionName = String(ctx?.action?.actionName || '').trim();
    const params = readParams(ctx);
    const bodyValues = ctx?.request?.body?.values;
    const actionValues = ctx?.action?.params?.values;
    const chartCollection = String(
      params?.collection
        || params?.table
        || params?.collectionName
        || actionValues?.collection
        || bodyValues?.collection
        || '',
    ).trim();

    const isDirectOrg = baseResource === 'latticeOrganizations';
    const isChartOnOrg =
      baseResource === 'charts' &&
      actionName === 'queryData' &&
      chartCollection === 'latticeOrganizations';

    if (!isDirectOrg && !isChartOnOrg) {
      return next();
    }

    const roles = await resolveVerifiedRoles(db, ctx);
    const ruRepo = db?.getRepository?.('rolesUsers');
    const hasRuRepo = Boolean(ruRepo && typeof ruRepo.find === 'function');
    const isRoot = roles.includes('root') || (!hasRuRepo && ctx?.state?.currentUser?.isRoot === true);
    if (isRoot) {
      return next();
    }

    throw fail(
      'ORGANIZATION_DIRECT_CRUD_FORBIDDEN',
      403,
      `Direct access to ${isChartOnOrg ? chartCollection : resourceName} is restricted to root; use /api/dxosBuilder:listTenants`,
    );
  };
}

class DxosStudioPlugin extends Plugin {
  stopAutomationListener() {
    if (this._automationListenerHandle && typeof this._automationListenerHandle.stop === 'function') {
      this._automationListenerHandle.stop();
    }
    this._automationListenerHandle = null;
    if (this._recordHooksHandle && typeof this._recordHooksHandle.stop === 'function') {
      this._recordHooksHandle.stop();
    }
    this._recordHooksHandle = null;
    if (this._richSchemaHooksHandle && typeof this._richSchemaHooksHandle.stop === 'function') {
      this._richSchemaHooksHandle.stop();
    }
    this._richSchemaHooksHandle = null;
    if (this._delayTicker) {
      clearInterval(this._delayTicker);
      this._delayTicker = null;
    }
  }

  async load() {
    this.db.on('latticeServiceTickets.beforeValidate', validateServiceTicket);
    for (const colName of WMS_DMN_COLLECTIONS) {
      this.db.on(`${colName}.beforeValidate`, validateTenantCollectionRecord);
    }

    this.app.resourceManager.use(createServiceScopeMiddleware(this.db), { tag: 'dxosServiceScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.use(createWmsDmnDirectGuardMiddleware(this.db), { tag: 'dxosWmsDmnScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.use(createAutomationDirectGuardMiddleware(this.db), { tag: 'dxosAutomationScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.use(createOrganizationDirectGuardMiddleware(this.db), { tag: 'dxosOrganizationScope', after: 'acl', before: 'latticeNativeScope' });

    this.app.resourceManager.define({
      name: 'dxosStudio',
      actions: createDxosStudioActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosWms',
      actions: createDxosWmsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosDmn',
      actions: createDxosDmnActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosDelegations',
      actions: createDxosDelegationsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosAutomations',
      actions: createDxosAutomationsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosBuilder',
      actions: createDxosBuilderActions(this.db),
    });
    const n8nRoutes = createN8nRouteHandlers(this.db, { app: this.app });
    this.app.resourceManager.define(n8nRoutes.resourceDef);

    this.app.acl.registerSnippet({
      name: 'pm.dxosStudio',
      actions: ['dxosStudio:*'],
    });
    this.app.acl.allow(
      'dxosWms',
      ['orderLines', 'saveOrderLine', 'receiveStock', 'lots', 'allocateFefo', 'issueStock', 'holdLotByMkt', 'epodCapture', 'printVoucher'],
      'loggedIn',
    );
    this.app.acl.allow('dxosWms', ['publicTrack', 'verifyTrackSignature'], 'public');
    this.app.acl.allow('dxosDmn', ['listTables', 'saveTable', 'evaluate'], 'loggedIn');
    this.app.acl.allow('dxosDelegations', ['list', 'create', 'revoke', 'activeForUser'], 'loggedIn');
    this.app.acl.allow('dxosAutomations', ['webhookIngress'], 'public');
    this.app.acl.allow(
      'dxosAutomations',
      [
        'listRules', 'saveRule', 'saveDraft', 'publishRule', 'listRuleVersions', 'rollbackRuleVersion',
        'toggleRule', 'deleteRule', 'testRule', 'runNow',
        'listRuns', 'getRunTrace', 'replayRun', 'builderCatalog', 'aiAssist',
        'nodeRegistry', 'testNode', 'resumeRun',
      ],
      'loggedIn',
    );
    this.app.acl.allow(
      'dxosBuilder',
      ['listDomains', 'createDomain', 'listBusinessPacks', 'installBusinessPack', 'listTenants', 'provisionTenant'],
      'loggedIn',
    );
    this.app.acl.allow(
      n8nRoutes.aclAllow.resource,
      n8nRoutes.aclAllow.actions,
      n8nRoutes.aclAllow.scope,
    );

    this.stopAutomationListener();
    this._automationListenerHandle = registerAutomationEventListener(this.app, this.db);
    this._recordHooksHandle = registerRecordTriggerHooks(this.app, this.db);
    this._richSchemaHooksHandle = registerRichSchemaHooks(this.db, { app: this.app });
    const rawTickMs = process.env.DX_FLOW_DELAY_TICK_MS;
    const delayTickMs = rawTickMs === undefined || rawTickMs === '' ? 15000 : Number(rawTickMs);
    if (Number.isFinite(delayTickMs) && delayTickMs >= 100) {
      this._delayTicker = setInterval(() => {
        tickFlowScheduler(this.db, { app: this.app }).catch(() => {});
      }, delayTickMs);
      if (typeof this._delayTicker.unref === 'function') this._delayTicker.unref();
    }
  }

  async unload() {
    this.stopAutomationListener();
  }

  async remove() {
    this.stopAutomationListener();
  }

  async destroy() {
    this.stopAutomationListener();
  }
}

DxosStudioPlugin.createOrganizationDirectGuardMiddleware = createOrganizationDirectGuardMiddleware;
DxosStudioPlugin.parseFormulaAst = parseFormulaAst;
DxosStudioPlugin.evaluateFormulaExpression = evaluateFormulaExpression;
DxosStudioPlugin.validateFormulaExpression = validateFormulaExpression;
DxosStudioPlugin.validateSafeRegexPattern = validateSafeRegexPattern;
DxosStudioPlugin.registerRichSchemaHooks = registerRichSchemaHooks;
module.exports = DxosStudioPlugin;
module.exports.default = DxosStudioPlugin;
