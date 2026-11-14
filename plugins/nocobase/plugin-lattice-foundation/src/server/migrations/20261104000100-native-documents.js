/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
}
module.exports=NativeDocuments;
module.exports.default=NativeDocuments;
