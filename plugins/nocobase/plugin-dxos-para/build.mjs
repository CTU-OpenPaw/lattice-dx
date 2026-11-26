/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

await checkDir(join(root, 'src'));
await mkdir(join(root, 'dist'), { recursive: true });
await cp(join(root, 'src'), join(root, 'dist'), { recursive: true });
await writeFile(
  join(root, 'dist/externalVersion.js'),
  externalVersionSource(['@nocobase/server', '@nocobase/database', '@nocobase/client', '@nocobase/client-v2', 'react', 'antd']),
  'utf8',
);
console.log('Built @latticedx/plugin-dxos-para (server + client entrypoints).');
