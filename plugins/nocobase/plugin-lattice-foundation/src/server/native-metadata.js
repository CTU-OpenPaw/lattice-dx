/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
async function exposeNativeCollections(db, definitions) {
  const repository = db.getRepository('collections');
  if (typeof repository.db2cm !== 'function') throw new Error('Native collection manager db2cm is unavailable');
  const schemas = Object.values(definitions).filter(schema => schema.uiManageable === true);
  for (const schema of schemas) {
    if (!db.hasCollection(schema.name)) throw new Error(`Collection is not loaded: ${schema.name}`);
  }
  const added=[];
  // Host db2cm creates missing metadata; never overwrite edited fields/layouts.
  // Each collection is an idempotent unit; a failed later unit can be retried.
  for (const schema of schemas) {
    if (await repository.findOne({filter:{name:schema.name}})) continue;
    await repository.db2cm(schema.name);
    added.push(schema.name);
  }
  return {added};
}
module.exports = {exposeNativeCollections};
