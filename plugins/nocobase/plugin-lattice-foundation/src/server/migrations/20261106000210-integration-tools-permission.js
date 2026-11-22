/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
const {installProposalPermission}=require('../native-integrations');
class NativeProposalPermission extends Migration{
 on='afterSync';async up(){await installProposalPermission(this.context.db);}
 async down(){
  const resources=this.context.db.getRepository?.('rolesResources');
  if(resources){
   await resources.destroy({filter:{name:'latticeProposals',roleName:{$in:['ldx_manager','ldx_admin']}}});
  }
 }
}
module.exports=NativeProposalPermission;module.exports.default=NativeProposalPermission;
