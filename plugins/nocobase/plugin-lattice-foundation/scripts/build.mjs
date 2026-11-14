/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {cp, mkdir, readdir, readFile, writeFile, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {externalVersionSource} from '../../../../scripts/lib/nocobase-externals.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function check(dir) {
  for (const item of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await check(path);
    else if (item.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], {stdio: 'inherit'});
      if (result.status !== 0) throw new Error(`Invalid JavaScript: ${path}`);
    }
  }
}
await check(join(root, 'src'));
await mkdir(join(root, 'dist'), {recursive: true});
await writeFile(join(root,'dist/externalVersion.js'),externalVersionSource(['@nocobase/server','@nocobase/database','@nocobase/client','@nocobase/client-v2','@nocobase/plugin-workflow','react','antd']));
await cp(join(root, 'src'), join(root, 'dist'), {recursive: true});
// cp does not remove retired modules from an earlier local build. Prevent
// auto-discovery from loading the old command journal/migrations again.
for(const path of ['server/native-documents.js','server/collections/command-receipts.js','server/migrations/20261104000200-native-role-fields.js','server/migrations/20261104000300-native-role-fields-projection.js','server/migrations/20261104000400-native-role-fields.js','server/migrations/20261104000500-native-dispatcher-submit.js']) {
  await unlink(join(root,'dist',path)).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
// Bundle the dependency graph of trusted package modules. Host SDK/React remain
// external. Adding an application extension does not require a bundler branch.
await unlink(join(root,'dist/client/logistics.js')).catch(error=>{if(error.code!=='ENOENT')throw error;});
async function bundle(entrySource,entryPath) {
  const modules=new Map();
  function modulePath(from,name) {
    let path=resolve(dirname(from),name.endsWith('.js')?name:name+'.js');
    if(!existsSync(path)){
      const dirIndex=resolve(dirname(from),name,'index.js');
      if(existsSync(dirIndex))path=dirIndex;
    }
    if(relative(join(root,'src'),path).startsWith('..'))throw new Error('Module outside plugin source: '+name);
    return path;
  }
  const moduleId=path=>relative(join(root,'src'),path).replaceAll('\\','/');
  async function collect(path) {
    const id=moduleId(path);if(modules.has(id))return;
    const source=await readFile(path,'utf8');modules.set(id,null);
    const dependencies={};
    for(const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if(!match[1].startsWith('.'))throw new Error('Unexpected external dependency: '+match[1]);
      const target=modulePath(path,match[1]);dependencies[match[1]]=moduleId(target);await collect(target);
    }
    modules.set(id,`function(module,exports){const require=name=>__load(${JSON.stringify(dependencies)}[name]);\n${source}\n}`);
  }
  let entry=entrySource;
  for(const match of entrySource.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const path=modulePath(entryPath,match[1]);await collect(path);
    entry=entry.replaceAll(match[0],`__load(${JSON.stringify(moduleId(path))})`);
  }
  const loader=`const __modules={${[...modules].map(([id,source])=>JSON.stringify(id)+':'+source).join(',\n')}};
const __cache=new Map();
function __load(id){if(!Object.hasOwn(__modules,id))throw new Error('Unknown bundled module: '+id);if(__cache.has(id))return __cache.get(id).exports;const module={exports:{}};__cache.set(id,module);__modules[id](module,module.exports);return module.exports;}\n`;
  return entry.replace("'use strict';",()=>"'use strict';\n"+loader);
}
for(const target of ['client','client-v2']) {
  const entry=join(root,'dist',target,'index.js');
  await writeFile(entry,await bundle(await readFile(entry,'utf8'),join(root,'src',target,'index.js')),'utf8');
  const result=spawnSync(process.execPath,['--check',entry],{stdio:'inherit'});
  if(result.status!==0)throw new Error('Invalid browser bundle: '+entry);
}
console.log('Built @latticedx/plugin-lattice-foundation (server + client entrypoints).');
