// SPDX-License-Identifier: Apache-2.0
import {cp, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
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
await cp(join(root, 'src'), join(root, 'dist'), {recursive: true});
// Bundle our two dependency-free modules into each browser entrypoint.
// NocoBase/React stay external and are supplied by the host's AMD loader.
const manifestSource = await readFile(join(root, 'src/shared/manifest.js'), 'utf8');
const actionSource = await readFile(join(root, 'src/client/actions.js'), 'utf8');
const workspaceApiSource = await readFile(join(root, 'src/client/workspace-api.js'), 'utf8');
const workspaceSource = await readFile(join(root, 'src/client/workspace.js'), 'utf8');
const blocksSource = await readFile(join(root, 'src/client/blocks.js'), 'utf8');
const listSource = await readFile(join(root, 'src/client/list-data.js'), 'utf8');
const bundledActions = `const manifestModule = (() => {const module = {exports: {}};\n${manifestSource}\nreturn module.exports;})();
const actions = (() => {const module = {exports: {}};
const require = name => {if (name === '../shared/manifest') return manifestModule; throw new Error('Unknown bundled module: ' + name);};
${actionSource}\nreturn module.exports;})();`;
for (const target of ['client', 'client-v2']) {
  const entry = join(root, 'dist', target, 'index.js');
  const source = await readFile(entry, 'utf8');
  let bundled = source.replace(/const actions = require\('\.?\.\/client\/actions'\);|const actions = require\('\.\/actions'\);/, () => bundledActions);
  const apiModule = `const workspaceApiModule = (() => {const module={exports:{}};\n${workspaceApiSource}\nreturn module.exports;})();`;
  const blocksModule = `const listModule=(()=>{const module={exports:{}};\n${listSource}\nreturn module.exports;})();
const blocksModule=(()=>{const module={exports:{}};const require=name=>{
if(name==='./actions')return actions;if(name==='./workspace-api')return workspaceApiModule;if(name==='./list-data')return listModule;throw new Error('Unknown block module: '+name);};
${blocksSource}\nreturn module.exports;})();`;
  const workspaceModule = `const {createWorkspaceComponent} = (() => {const module={exports:{}};
const require = name => {if (name === './workspace-api') return workspaceApiModule; throw new Error('Unknown bundled module: ' + name);};
${workspaceSource}\nreturn module.exports;})();`;
  bundled = bundled.replace("const {createWorkspaceComponent} = require('./workspace');", () => apiModule+'\n'+blocksModule+'\n'+workspaceModule);
  bundled = bundled.replace("const {createBlockComponents} = require('./blocks');", 'const {createBlockComponents} = blocksModule;');
  bundled = bundled.replace(/const \{createWorkspaceApi\} = require\('(?:\.\/|\.\.\/client\/)workspace-api'\);/g,
    () => (target === 'client-v2' ? apiModule+'\n' : '')+'const {createWorkspaceApi} = workspaceApiModule;');
  await writeFile(entry, bundled, 'utf8');
  const result = spawnSync(process.execPath, ['--check', entry], {stdio: 'inherit'});
  if (result.status !== 0) throw new Error(`Invalid browser bundle: ${entry}`);
}
console.log('Built @latticedx/plugin-lattice-foundation (server + client entrypoints).');
