/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {BaseAuth}=require('@nocobase/auth');
const {denied,resolveMappedUser}=require('./policy');
// A private Symbol can only be supplied by our verified, one-time finish action.
const verifiedIdentity=Symbol('verifiedEnterpriseIdentity');
class EnterpriseAuth extends BaseAuth {
  constructor(config){super({...config,userCollection:config.ctx.db.getCollection('users')});}
  async validate(){
    const verified=this.ctx.state[verifiedIdentity];
    if(!verified||verified.authenticator!==this.authenticator.name)throw denied();
    return resolveMappedUser(this.ctx.db,this.authenticator.name,verified.subject,verified.issuer);
  }
  async signUp(){throw denied();}
}
module.exports={EnterpriseAuth,verifiedIdentity};
