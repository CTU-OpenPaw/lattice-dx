/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Trusted extensions register contracts in code; manifests only reference their IDs.
function createContractRegistry() {
  const actions=new Map(),resources=new Map(),references=new Map();
  function register(map,name,value) {
    if(typeof name!=='string'||!/^[a-z][a-zA-Z0-9._-]{0,79}$/.test(name)||map.has(name)||!value)throw new Error('Invalid or duplicate contract: '+name);
    map.set(name,Object.freeze(value));return value;
  }
  return {
    registerAction:(name,value)=>register(actions,name,value), action:name=>actions.get(name),
    registerResource:(name,value)=>register(resources,name,value), resource:name=>resources.get(name),
    registerReference:(name,value)=>register(references,name,value), reference:name=>references.get(name),
  };
}
const defaultContracts=createContractRegistry();
require('../applications/contracts').registerApplicationContracts(defaultContracts);
module.exports={createContractRegistry,defaultContracts};
