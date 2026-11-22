/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { validateManifest } = require('../plugins/nocobase/plugin-lattice-foundation/src/shared/manifest.js');
const { parseBundle, bundlePreview } = await import('../apps/api/src/workflows/bundles.js');
const uc1 = require('../packages/uc1-procurement/index.js');

async function main() {
  console.log('--- Step 1: Validating UC1 Manifests ---');
  const purchasingErrors = validateManifest(uc1.purchasing);
  if (purchasingErrors.length) throw new Error('Purchasing manifest invalid: ' + purchasingErrors.join(', '));
  console.log('✔ Purchasing manifest valid.');

  const workErrors = validateManifest(uc1.work);
  if (workErrors.length) throw new Error('Work manifest invalid: ' + workErrors.join(', '));
  console.log('✔ Work manifest valid.');

  console.log('--- Step 2: Validating Workflow Bundle ---');
  const parsed = parseBundle(uc1.workflowBundle);
  const preview = bundlePreview(parsed);
  console.log(`✔ Workflow bundle valid (${preview.workflowCount} definition, roles: ${preview.definitions[0].requiredRoles.join(', ')}).`);

  console.log('--- Step 3: Packaging UC1 Archive ---');
  const outputDir = resolve(root, 'output/packages');
  await mkdir(outputDir, { recursive: true });

  const pkgDir = resolve(root, 'packages/uc1-procurement');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tarballName = execFileSync(npmCmd, ['pack', '--pack-destination', outputDir], {
    cwd: pkgDir,
    encoding: 'utf8',
    shell: true,
    windowsHide: true
  }).trim();

  const tarballPath = resolve(outputDir, tarballName);
  const tarballBytes = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(tarballBytes).digest('hex');

  const manifestExport = {
    packageName: uc1.packageInfo.name,
    version: uc1.packageInfo.version,
    useCase: uc1.packageInfo.useCase,
    schemaVersion: uc1.packageInfo.schemaVersion,
    exportedAt: new Date().toISOString(),
    tarball: {
      filename: tarballName,
      size: tarballBytes.length,
      sha256
    },
    applications: [
      { id: uc1.purchasing.id, name: uc1.purchasing.name, route: uc1.purchasing.route },
      { id: uc1.work.id, name: uc1.work.name, route: uc1.work.route }
    ],
    workflowDefinitions: preview.definitions.map(d => ({
      id: d.id,
      title: d.title,
      roles: d.requiredRoles
    }))
  };

  const manifestPath = resolve(outputDir, 'uc1-package-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifestExport, null, 2), 'utf8');

  console.log('--- UC1 Package Export Succeeded ---');
  console.log(JSON.stringify(manifestExport, null, 2));
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
