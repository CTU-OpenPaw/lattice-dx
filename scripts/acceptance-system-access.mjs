// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');

const bundle = esbuild.buildSync({
  entryPoints: ['scripts/system-access-acceptance.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['pg'],
  write: false,
  logLevel: 'silent',
}).outputFiles[0].contents;

try {
  const result = execFileSync(
    'docker',
    [
      '--context',
      'desktop-linux',
      'compose',
      '-f',
      'infra/compose/core.yml',
      'exec',
      '-T',
      '-w',
      '/app/apps/api',
      'api',
      'node',
    ],
    {
      input: bundle,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  console.log(result.trim());
} catch (error) {
  if (error.stdout) console.log(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  console.error('System Access SQL acceptance failed.');
  process.exitCode = 1;
}
