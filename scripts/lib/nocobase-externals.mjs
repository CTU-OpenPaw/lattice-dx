// SPDX-License-Identifier: Apache-2.0
// Verified against the official 2.2.38 image SDK and plugin-auth's emitted
// dist/externalVersion.js. These are build target versions, never a runtime
// lookup that would make the checker pass against an arbitrary host.
const sdk='2.2.38';
const versions={'@nocobase/server':sdk,'@nocobase/auth':sdk,'@nocobase/plugin-auth':sdk,'@nocobase/database':sdk,'@nocobase/client':sdk,'@nocobase/client-v2':sdk,'@nocobase/plugin-workflow':sdk,react:'18.2.0',antd:'5.24.2'};
export function externalVersionSource(names) {
  const declared={};
  for(const name of names){if(!Object.hasOwn(versions,name))throw Error('Unverified host dependency: '+name);declared[name]=versions[name];}
  return '// SPDX-License-Identifier: Apache-2.0\nmodule.exports = '+JSON.stringify(declared,null,2)+';\n';
}
