/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
const schemas=require('../schema');
const {exposeNativeCollections}=require('../native-metadata');
const {installRolePresets}=require('../native-roles');
class NativeDocuments extends Migration {
  on='afterSync';
  async up(){await exposeNativeCollections(this.context.db,schemas);await installRolePresets(this.context.db);}
  async down(){
    const db=this.context.db;
    const roles=db.getRepository?.('roles');
    const rolesUsers=db.getRepository?.('rolesUsers');
    if(!roles)return;
    for(const name of ['ldx_employee','ldx_manager','ldx_warehouse','ldx_dispatcher','ldx_driver','ldx_director','ldx_admin']){
      if(rolesUsers&&(await rolesUsers.count({filter:{roleName:name}}))>0)continue;
      await roles.destroy({filter:{name}});
    }
  }
}
module.exports=NativeDocuments;
module.exports.default=NativeDocuments;
