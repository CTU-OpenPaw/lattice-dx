// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
const build = spawnSync(process.execPath, ['plugins/nocobase/action-bridge/build.mjs'], {stdio: 'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const args = ['compose', '-f', 'infra/compose/nocobase.yml', 'exec', '-T', 'nocobase', 'yarn', 'nocobase', 'pm', 'enable', '@latticedx/plugin-action-bridge'];
const result = spawnSync('docker', args, { stdio: 'inherit', timeout: 120000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
