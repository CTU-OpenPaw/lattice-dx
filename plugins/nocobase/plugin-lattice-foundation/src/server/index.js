/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { Plugin } = require('@nocobase/server');
const { seedFoundation } = require('./seed');
const {createApplicationCatalog}=require('../shared/application-catalog');
const {registerSampleApplications}=require('../applications/catalog');
const {defaultContracts}=require('../shared/contracts');
const {registerNativeResource}=require('./native-resource');
const {registerNativeRequestAttachments}=require('./native-request-attachments');
const {createNativeSharedFiles}=require('./native-shared-files');
const schemas=require('./schema');
const {createNativeScopeMiddleware}=require('./native-scope');
const {registerNativeIdentityHooks}=require('./native-identity-hooks');
const {registerContextHooks}=require('./native-context');
const {registerContextResource}=require('./native-context-delivery');
const {registerNativeIntegrations}=require('./native-integrations');
const {registerNativePortals}=require('./native-portals');
const {registerChatterResource}=require('./record-chatter');
const {registerVoucherLifecycleResource}=require('./voucher-lifecycle');
const {registerNotificationCenter}=require('./notification-center');
const {registerSlaEngine}=require('./sla-engine');
const {registerObservability}=require('./observability');
const {registerPaasApiKeys, createPaasApiKeyAuthMiddleware}=require('./paas-api-keys');
const {registerPkiLedger, appendLedgerEntrySafely}=require('./pki-ledger');
const {
  registerDataGovernance,
  computeMeanKineticTemperature,
  recordLineageEdge,
  captureQuarantineRecord,
}=require('./data-governance');
const {
  registerConnectorVault,
  resolveConnectorSecrets,
}=require('./connector-vault');
const {
  registerEventBus,
  publishDomainEvent,
  registerEventBusListener,
  verifyStandardWebhookSignature,
}=require('./event-bus');
const {attachRlsPolicyToTable, canUsePgRlsSession, withSystemRlsBypass}=require('./pg-rls');
class LatticeFoundationPlugin extends Plugin {
  async load() {
    this.db.attachLatticeRlsPolicy = (tableName, txOrOpts) => {
      const opts = txOrOpts && typeof txOrOpts === 'object' && ('transaction' in txOrOpts || 'schema' in txOrOpts || 'policyName' in txOrOpts)
        ? txOrOpts
        : (txOrOpts ? { transaction: txOrOpts } : {});
      return attachRlsPolicyToTable(this.db, tableName, opts);
    };
    registerNativeResource(this.app);
    const sharedFiles = createNativeSharedFiles({
      url: process.env.DX_NATIVE_FILES_URL, secret: process.env.DX_NATIVE_FILES_SECRET, instance: process.env.DX_NATIVE_FILES_INSTANCE,
    });
    if (process.env.DX_NATIVE_CLAMD_HOST || sharedFiles) {
      registerNativeRequestAttachments(this.app, process.env.DX_NATIVE_CLAMD_HOST, process.env.DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION, sharedFiles);
    }
    registerNativeIdentityHooks(this.db);
    registerContextHooks(this.db);
    registerContextResource(this.app);
    registerNativeIntegrations(this.app);
    registerNativePortals(this.app, this.db);
    registerChatterResource(this.app);
    registerVoucherLifecycleResource(this.app);
    registerNotificationCenter(this.app);
    registerSlaEngine(this.app);
    registerObservability(this.app);
    registerPaasApiKeys(this.app);
    registerPkiLedger(this.app);
    registerDataGovernance(this.app);
    const vaultApi = registerConnectorVault(this.app);
    const eventBusApi = registerEventBus(this.app, { startDrainer: true });
    this.app.latticeVault = vaultApi;
    this.app.latticeEvents = eventBusApi;
    this._stopEventBusDrainer = eventBusApi.stopDrainer;
    this.app.resourceManager.use(createPaasApiKeyAuthMiddleware(this.db),{tag:'latticePaasApiKeyAuth',before:'auth'});
    this.app.resourceManager.use(createNativeScopeMiddleware(this.db,schemas),{tag:'latticeNativeScope',after:'acl'});
    const catalog=createApplicationCatalog();
    registerSampleApplications(catalog);
    this.app.latticeApplications=catalog;
    this.app.latticeContracts=defaultContracts;
    this.app.resourceManager.define({name: 'latticeApps', actions: {
      list: async (ctx, next) => {
        if (ctx.method !== 'GET') ctx.throw(405);
        ctx.body = {items: catalog.list()};
        await next();
      },
      get: async (ctx, next) => {
        if (ctx.method !== 'GET') ctx.throw(405);
        const manifest = catalog.get(ctx.action.params.filterByTk);
        if (!manifest) ctx.throw(404, 'Application configuration not found.');
        ctx.body = manifest;
        await next();
      },
    }});
    this.app.acl.allow('latticeApps', ['list', 'get'], 'loggedIn');
  }
  stopEventBusDrainer() {
    if (typeof this._stopEventBusDrainer === 'function') {
      this._stopEventBusDrainer();
      this._stopEventBusDrainer = null;
    }
  }
  async unload() {
    this.stopEventBusDrainer();
    if (typeof super.unload === 'function') await super.unload();
  }
  async remove() {
    this.stopEventBusDrainer();
    if (typeof super.remove === 'function') await super.remove();
  }
  async destroy() {
    this.stopEventBusDrainer();
    if (typeof super.destroy === 'function') await super.destroy();
  }
  async install() {
    if (canUsePgRlsSession(this.db)) {
      await withSystemRlsBypass(this.db, (transaction) => seedFoundation(this.db, transaction));
      return;
    }
    await this.db.sequelize.transaction((transaction) => seedFoundation(this.db, transaction));
  }
}
LatticeFoundationPlugin.appendLedgerEntrySafely = appendLedgerEntrySafely;
LatticeFoundationPlugin.computeMeanKineticTemperature = computeMeanKineticTemperature;
LatticeFoundationPlugin.recordLineageEdge = recordLineageEdge;
LatticeFoundationPlugin.captureQuarantineRecord = captureQuarantineRecord;
LatticeFoundationPlugin.registerDataGovernance = registerDataGovernance;
LatticeFoundationPlugin.publishDomainEvent = publishDomainEvent;
LatticeFoundationPlugin.registerEventBusListener = registerEventBusListener;
LatticeFoundationPlugin.verifyStandardWebhookSignature = verifyStandardWebhookSignature;
LatticeFoundationPlugin.resolveConnectorSecrets = resolveConnectorSecrets;
module.exports = LatticeFoundationPlugin;
module.exports.default = LatticeFoundationPlugin;
