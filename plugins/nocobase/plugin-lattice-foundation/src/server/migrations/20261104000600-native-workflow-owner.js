// SPDX-License-Identifier: Apache-2.0
const {Migration}=require('@nocobase/server');
const {migrateUnusedLegacyRoles}=require('../native-roles');
class NativeWorkflowOwner extends Migration {
  on='afterSync';
  async up(){await migrateUnusedLegacyRoles(this.context.db);}
}
module.exports=NativeWorkflowOwner;
module.exports.default=NativeWorkflowOwner;
