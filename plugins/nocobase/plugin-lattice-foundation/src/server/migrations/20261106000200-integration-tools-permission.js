// SPDX-License-Identifier: Apache-2.0
const {Migration}=require('@nocobase/server');
const {installProposalPermission}=require('../native-integrations');
class NativeProposalPermission extends Migration{
 on='afterSync';async up(){await installProposalPermission(this.context.db);}
}
module.exports=NativeProposalPermission;module.exports.default=NativeProposalPermission;
