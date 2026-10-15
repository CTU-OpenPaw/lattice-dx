// SPDX-License-Identifier: Apache-2.0
const { Plugin } = require('@nocobase/server');
const { seedFoundation } = require('./seed');
const {createApplicationCatalog}=require('../shared/application-catalog');
const {registerSampleApplications}=require('../applications/catalog');
const {defaultContracts}=require('../shared/contracts');
class LatticeFoundationPlugin extends Plugin {
  async load() {
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
