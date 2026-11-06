// SPDX-License-Identifier: Apache-2.0
import {cp,mkdir,writeFile} from 'node:fs/promises';
import {externalVersionSource} from '../../../scripts/lib/nocobase-externals.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url);
for(const path of ['src/client/index.js','src/server/index.js','src/server/routes.js','src/server/auth.js','src/server/policy.js','src/server/oidc.js']){
  const checked=spawnSync(process.execPath,['--check',fileURLToPath(new URL(path,root))],{stdio:'inherit'});
  if(checked.status!==0)throw Error('Invalid JavaScript: '+path);
}
await mkdir(new URL('dist/',root),{recursive:true});
await cp(new URL('src/',root),new URL('dist/',root),{recursive:true});
await writeFile(new URL('dist/externalVersion.js',root),externalVersionSource(['@nocobase/server','@nocobase/auth','@nocobase/client','@nocobase/plugin-auth','react','antd']));
console.log('Enterprise login plugin built; host SDK remains external.');
