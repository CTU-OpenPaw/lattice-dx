/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
const {migrateUnusedLegacyRoles}=require('../native-roles');
class NativeWorkflowOwner extends Migration {
  on='afterSync';
  async up(){await migrateUnusedLegacyRoles(this.context.db);}
  async down(){
    const db=this.context.db;
    const resources=db.getRepository?.('rolesResources');
    if(resources){
      await resources.destroy({filter:{name:'latticeDocuments',roleName:{$in:['ldx_employee','ldx_manager','ldx_warehouse','ldx_dispatcher','ldx_driver','ldx_director','ldx_admin']}}});
    }
  }
}
module.exports=NativeWorkflowOwner;
module.exports.default=NativeWorkflowOwner;
