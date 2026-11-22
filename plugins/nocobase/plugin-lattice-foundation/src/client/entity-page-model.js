/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { attributesFromForm } = require('./console-model');
function entityPageSchema(page, schemas) {
  const schema = schemas.find(item => item.id === page.schemaId && (item.version || 1) === page.schemaVersion);
  if (!schema) throw Error('Không tìm thấy phiên bản cấu trúc của trang.');
  return schema;
}
function entityPageQuery(page, offset = 0) {
  return {schemaId:page.schemaId,schemaVersion:page.schemaVersion,filters:page.query?.filters || [],...(page.query?.sort ? {sort:page.query.sort} : {}),limit:20,offset};
}
function entityPageAttributes(page, schema, values, previous = {}) {
  const fields = {};
  for (const name of page.fields) {
    if (!Object.hasOwn(schema.fields,name)) throw Error('Trường ngoài cấu trúc: '+name);
    fields[name] = schema.fields[name];
  }
  const attributes = {...previous};
  for (const name of page.fields) delete attributes[name];
  return {...attributes,...attributesFromForm(fields,values)};
}
function entityPageCanWrite(session,page,enabled,action) {
  return enabled !== false && !session.busy && !session.commands.uncertain && !!session.capabilities['entities.write']?.available && page.actions.includes(action);
}
module.exports={entityPageSchema,entityPageQuery,entityPageAttributes,entityPageCanWrite};
