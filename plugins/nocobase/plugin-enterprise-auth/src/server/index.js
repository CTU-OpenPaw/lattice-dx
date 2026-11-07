// SPDX-License-Identifier: Apache-2.0
const {Plugin}=require('@nocobase/server');
const {EnterpriseAuth,verifiedIdentity}=require('./auth');
const {createActions,TYPE}=require('./routes');
class EnterpriseLoginPlugin extends Plugin {
  async load(){
    const cache=await this.app.cacheManager.createCache({name:'enterprise-login',prefix:'enterprise-login',store:'memory'});
    this.app.authManager.registerTypes(TYPE,{auth:EnterpriseAuth,title:'Enterprise login (Keycloak)',getPublicOptions:()=>({})});
    const actions=createActions(this.app,cache,verifiedIdentity);
    this.app.resourceManager.define({name:'enterpriseAuth',actions});
    this.app.acl.allow('enterpriseAuth',['start','callback','finish'],'public');
    this.app.acl.allow('enterpriseAuth',['configuration','link'],'loggedIn');
  }
}
module.exports=EnterpriseLoginPlugin;
module.exports.default=EnterpriseLoginPlugin;
