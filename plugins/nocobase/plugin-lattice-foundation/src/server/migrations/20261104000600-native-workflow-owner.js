/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
const {migrateUnusedLegacyRoles}=require('../native-roles');
class NativeWorkflowOwner extends Migration {
  on='afterSync';
  async up(){await migrateUnusedLegacyRoles(this.context.db);}
}
module.exports=NativeWorkflowOwner;
module.exports.default=NativeWorkflowOwner;
