/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {Migration} = require('@nocobase/server');
const schemas = require('../schema');
const {exposeNativeCollections} = require('../native-metadata');
class NativeFoundation extends Migration {
  on = 'afterSync';
  async up() {
    await exposeNativeCollections(this.context.db, schemas);
  }
}
module.exports = NativeFoundation;
module.exports.default = NativeFoundation;
