// SPDX-License-Identifier: Apache-2.0
const {validateCatalog}=require('./manifest');
const {defaultContracts}=require('./contracts');
function createApplicationCatalog(contracts=defaultContracts) {
  const manifests=new Map();
  return {
    register(manifest){
      const errors=validateCatalog([...manifests.values(),manifest],contracts);
      if(errors.length)throw new Error('Invalid application catalog: '+errors.join('; '));
      // Own a snapshot; an extension cannot mutate validated routes/fields later.
      manifests.set(manifest.id,JSON.parse(JSON.stringify(manifest)));
    },
    list:()=>JSON.parse(JSON.stringify([...manifests.values()])),
    get:id=>manifests.has(id)?JSON.parse(JSON.stringify(manifests.get(id))):undefined,
  };
}
module.exports={createApplicationCatalog};
