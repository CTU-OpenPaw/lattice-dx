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
class LatticeFoundationPlugin extends Plugin {
  async load() {
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
  async install() {
    await this.db.sequelize.transaction((transaction) => seedFoundation(this.db, transaction));
  }
}
module.exports = LatticeFoundationPlugin;
module.exports.default = LatticeFoundationPlugin;
