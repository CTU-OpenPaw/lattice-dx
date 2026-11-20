/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const path = new URL('../.env.integration', import.meta.url);
let text;
try { text = await readFile(path, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
const matches = [...text.matchAll(/^\s*NGSI_LD_NOTIFICATION_TOKEN\s*=\s*(.*)\s*$/gm)];
if (matches.length > 1) throw new Error('Duplicate NGSI_LD_NOTIFICATION_TOKEN entries; keep exactly one.');
if (matches.length) {
  const token = matches[0][1].trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error('Existing notification token is invalid; use 32–256 URL-safe characters.');
  console.log('Existing NGSI-LD notification token retained; no secret printed.');
} else {
  await writeFile(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}NGSI_LD_NOTIFICATION_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  console.log('NGSI-LD notification token added to .env.integration; existing settings retained.');
}
