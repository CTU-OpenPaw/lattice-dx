/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
}
module.exports=NativeIntegration;module.exports.default=NativeIntegration;
