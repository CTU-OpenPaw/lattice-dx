/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { externalVersionSource } from '../../../scripts/lib/nocobase-externals.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));

async function checkDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await checkDir(full);
    else if (entry.name.endsWith('.js')) {
      const res = spawnSync(process.execPath, ['--check', full], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`Invalid JavaScript: ${full}`);
    }
  }
}

const SAFE_MODULE_ID_RE = /^[A-Za-z0-9_./-]+$/;

async function bundleEntry(entrySource, entryPath) {
  const modules = new Map();
  const depsMap = {};
  function resolveModulePath(from, spec) {
    let candidate = resolve(dirname(from), spec.endsWith('.js') ? spec : `${spec}.js`);
    if (!existsSync(candidate)) {
      const idx = resolve(dirname(from), spec, 'index.js');
      if (existsSync(idx)) candidate = idx;
    }
    if (relative(join(root, 'src'), candidate).startsWith('..')) {
      throw new Error(`Module outside plugin source: ${spec}`);
    }
    return candidate;
  }
  const moduleId = (p) => relative(join(root, 'src'), p).replaceAll('\\', '/');
  async function collect(modPath) {
    const id = moduleId(modPath);
    if (modules.has(id)) return;
    if (!SAFE_MODULE_ID_RE.test(id)) throw new Error(`Invalid bundled module id: ${id}`);
    const source = await readFile(modPath, 'utf8');
    modules.set(id, null);
    const deps = {};
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (!match[1].startsWith('.')) throw new Error(`Unexpected external dependency in bundled module: ${match[1]}`);
      const target = resolveModulePath(modPath, match[1]);
      deps[match[1]] = moduleId(target);
      await collect(target);
    }
    depsMap[id] = deps;
    modules.set(id, 'function(module,exports,__id){const require=name=>__load(__deps[__id][name]);\n' + source + '\n}');
  }
  let output = entrySource;
  for (const match of entrySource.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const target = resolveModulePath(entryPath, match[1]);
    await collect(target);
    const targetId = moduleId(target);
    output = output.replaceAll(match[0], `__load('${targetId}')`);
  }
  const depsHeader = 'const __deps = ' + JSON.stringify(depsMap) + ';\n';
  const moduleEntries = [...modules].map(([id, src]) => `'${id}':${src}`).join(',\n');
  const loader = `${depsHeader}const __modules={${moduleEntries}};
const __cache=new Map();
function __load(id){if(!Object.hasOwn(__modules,id))throw new Error('Unknown bundled module: '+id);if(__cache.has(id))return __cache.get(id).exports;const module={exports:{}};__cache.set(id,module);__modules[id](module,module.exports,id);return module.exports;}\n`;
  return output.replace("'use strict';", () => `'use strict';\n${loader}`);
}

await checkDir(join(root, 'src'));
await mkdir(join(root, 'dist'), { recursive: true });
await cp(join(root, 'src'), join(root, 'dist'), { recursive: true });
await writeFile(
  join(root, 'dist/externalVersion.js'),
  externalVersionSource(['@nocobase/server', '@nocobase/database', '@nocobase/client', '@nocobase/client-v2', 'react', 'antd']),
  'utf8',
);

const clientEntry = join(root, 'dist/client/index.js');
await writeFile(clientEntry, await bundleEntry(await readFile(clientEntry, 'utf8'), join(root, 'src/client/index.js')), 'utf8');
const syntaxCheck = spawnSync(process.execPath, ['--check', clientEntry], { stdio: 'inherit' });
if (syntaxCheck.status !== 0) throw new Error(`Invalid bundled client: ${clientEntry}`);

console.log('Built @latticedx/plugin-dxos-ai (server + client entrypoints).');
