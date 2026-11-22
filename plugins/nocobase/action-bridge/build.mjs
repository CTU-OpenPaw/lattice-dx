/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {cp, mkdir,writeFile} from 'node:fs/promises';
import {externalVersionSource} from '../../../scripts/lib/nocobase-externals.mjs';
const root = new URL('./', import.meta.url);
await mkdir(new URL('dist/', root), {recursive: true});
await writeFile(new URL('dist/externalVersion.js',root),externalVersionSource(['@nocobase/server','@nocobase/client','@nocobase/client-v2']));
await cp(new URL('src/', root), new URL('dist/', root), {recursive: true});
console.log('Action Bridge client entrypoints built.');
