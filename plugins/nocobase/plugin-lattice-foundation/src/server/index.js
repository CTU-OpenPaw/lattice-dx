// SPDX-License-Identifier: Apache-2.0
const { Plugin } = require('@nocobase/server');
const { seedFoundation } = require('./seed');
const {validateCatalog} = require('../shared/manifest');
const manifests = [require('../shared/manifests/purchasing.json'), require('../shared/manifests/logistics.json')];
class LatticeFoundationPlugin extends Plugin {
  async load() {
    const errors = validateCatalog(manifests);
    if (errors.length) throw new Error(`Invalid application catalog: ${errors.join('; ')}`);
    this.app.resourceManager.define({name: 'latticeApps', actions: {
      list: async (ctx, next) => {
        if (ctx.method !== 'GET') ctx.throw(405);
        ctx.body = {items: manifests};
        await next();
      },
      get: async (ctx, next) => {
        if (ctx.method !== 'GET') ctx.throw(405);
        const manifest = manifests.find(m => m.id === ctx.action.params.filterByTk);
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
