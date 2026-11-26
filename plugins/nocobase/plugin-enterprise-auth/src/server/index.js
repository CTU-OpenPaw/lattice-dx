/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Plugin}=require('@nocobase/server');
const {EnterpriseAuth,verifiedIdentity}=require('./auth');
const {createActions,TYPE}=require('./routes');
const {resolveCacheOptions,createRevocationGuard}=require('./policy');
class EnterpriseLoginPlugin extends Plugin {
  async load(){
    const cacheOpts=resolveCacheOptions(process.env);
    let cache;
    try{
      cache=await this.app.cacheManager.createCache(cacheOpts);
    }catch(error){
      if(cacheOpts.store!=='memory'){
        this.app.logger?.warn?.('[enterprise-auth] Redis cache store unavailable, falling back to memory cache');
        cache=await this.app.cacheManager.createCache({name:'enterprise-login',prefix:'enterprise-login',store:'memory'});
      }else throw error;
    }
    this.app.authManager.registerTypes(TYPE,{auth:EnterpriseAuth,title:'Enterprise login (Keycloak)',getPublicOptions:()=>({})});
    const actions=createActions(this.app,cache,verifiedIdentity);
    this.app.resourceManager.define({name:'enterpriseAuth',actions});
    this.app.use(createRevocationGuard(cache),{tag:'enterpriseAuthRevocationGuard',after:'auth'});
    this.app.acl.allow('enterpriseAuth',['start','callback','finish','backchannelLogout'],'public');
    this.app.acl.allow('enterpriseAuth',['configuration','link','listLinkTargets','listMappings','unlink'],'loggedIn');
  }
}
module.exports=EnterpriseLoginPlugin;
module.exports.default=EnterpriseLoginPlugin;
