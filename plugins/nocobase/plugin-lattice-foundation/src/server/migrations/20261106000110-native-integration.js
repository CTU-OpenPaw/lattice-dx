/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration}=require('@nocobase/server');
const {exposeNativeCollections}=require('../native-metadata');
const {installConnectorRole}=require('../native-integrations');
class NativeIntegration extends Migration{
 on='afterSync';
 async up(){await exposeNativeCollections(this.context.db,require('../integration-schema'));await installConnectorRole(this.context.db);}
 async down(){
  const db=this.context.db;
  await db.getRepository?.('roles')?.destroy({filter:{name:'ldx_connector'}});
  await db.getRepository?.('collections')?.destroy({filter:{name:{$in:['latticeIntegrationInbox','latticeAgentProposals']}}});
 }
}
module.exports=NativeIntegration;module.exports.default=NativeIntegration;
