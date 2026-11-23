/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  formatSbomJson,
  generateSbom,
  parseComposeImages,
  parsePnpmLockPackages,
  runSbomCli,
} from '../generate-sbom.mjs';

function makeTempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'latticedx-sbom-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeMinimalProject(dir, {
  rootLicense = 'Apache-2.0',
  composeContent = 'services:\n  db:\n    image: postgres:16-alpine@sha256:' + 'a'.repeat(64) + '\n',
  pnpmLockContent = 'lockfileVersion: \'9.0\'\npackages:\n\n  zod@3.24.2:\n    resolution: {integrity: sha512-2kJm+q0S0vP9v4fK5v7z7Q==}\n\nsnapshots:\n',
  authLock = {
    name: '@latticedx/plugin-enterprise-auth',
    lockfileVersion: 3,
    packages: {
      '': { name: '@latticedx/plugin-enterprise-auth', version: '1.0.0' },
      'node_modules/jose': {
        version: '6.2.15',
        license: 'MIT',
        integrity: 'sha512-test1234',
      },
    },
  },
} = {}) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'lattice-dx',
    version: '1.0.0',
    license: rootLicense,
  }, null, 2));
  mkdirSync(join(dir, 'plugins', 'nocobase', 'plugin-lattice-foundation'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'nocobase', 'plugin-lattice-foundation', 'package.json'), JSON.stringify({
    name: '@latticedx/plugin-lattice-foundation',
    version: '1.0.0',
    license: 'Apache-2.0',
  }, null, 2));
  mkdirSync(join(dir, 'plugins', 'nocobase', 'plugin-enterprise-auth'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'nocobase', 'plugin-enterprise-auth', 'package.json'), JSON.stringify({
    name: '@latticedx/plugin-enterprise-auth',
    version: '1.0.0',
    license: 'Apache-2.0',
  }, null, 2));
  writeFileSync(
    join(dir, 'plugins', 'nocobase', 'plugin-enterprise-auth', 'package-lock.json'),
    JSON.stringify(authLock, null, 2),
  );
  mkdirSync(join(dir, 'infra', 'compose'), { recursive: true });
  writeFileSync(join(dir, 'infra', 'compose', 'core.yml'), composeContent);
  writeFileSync(join(dir, 'pnpm-lock.yaml'), pnpmLockContent);
}

test('generateSbom produces deterministic CycloneDX 1.5 BOM covering workspace plugins, lockfiles, and @sha256 OCI images', () => {
  const first = generateSbom({ rootDir: REPO_ROOT });
  const second = generateSbom({ rootDir: REPO_ROOT });

  assert.equal(first.bom.bomFormat, 'CycloneDX');
  assert.equal(first.bom.specVersion, '1.5');
  assert.equal(first.bom.metadata.component.name, 'lattice-dx');
  assert.equal(first.bom.metadata.component.version, '1.0.0');
  assert.equal(formatSbomJson(first.bom), formatSbomJson(second.bom));

  assert.ok(first.counts.workspace >= 12, `Expected >= 12 workspace components, got ${first.counts.workspace}`);
  assert.ok(first.counts.thirdPartyNpm >= 170, `Expected >= 170 npm dependencies, got ${first.counts.thirdPartyNpm}`);
  assert.ok(first.counts.containers >= 15, `Expected >= 15 pinned OCI images, got ${first.counts.containers}`);

  const names = new Set(first.bom.components.map((c) => c.name));
  for (const pluginName of [
    '@latticedx/plugin-action-bridge',
    '@latticedx/plugin-lattice-foundation',
    '@latticedx/plugin-enterprise-auth',
    '@latticedx/plugin-dxos-para',
    '@latticedx/plugin-dxos-blocks',
    '@latticedx/plugin-dxos-studio',
    '@latticedx/plugin-dxos-ai',
  ]) {
    assert.ok(names.has(pluginName), `Missing NocoBase plugin in SBOM: ${pluginName}`);
  }
  assert.ok(names.has('openid-client'), 'Missing bundled OIDC dependency openid-client');
  assert.ok(names.has('jose'), 'Missing bundled OIDC dependency jose');

  const ociImages = first.bom.components.filter((c) => c.type === 'container');
  for (const img of ociImages) {
    assert.match(img.version, /^sha256:[a-f0-9]{64}$/);
    assert.equal(img.hashes?.[0]?.alg, 'SHA-256');
  }
});

test('parsePnpmLockPackages handles scoped packages and hashes accurately', () => {
  const parsed = parsePnpmLockPackages(`
lockfileVersion: '9.0'
packages:

  '@esbuild/linux-x64@0.28.2':
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}

  zod@3.24.2:
    resolution: {integrity: sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==}

snapshots:
  zod@3.24.2: {}
`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, '@esbuild/linux-x64');
  assert.equal(parsed[0].version, '0.28.2');
  assert.equal(parsed[0].hashes[0].alg, 'SHA-512');
  assert.equal(parsed[1].name, 'zod');
  assert.equal(parsed[1].version, '3.24.2');
});

test('generateSbom rejects unpinned Compose images and banned ThingsBoard / EMQX / BSL-1.1 components', (t) => {
  const unpinnedDir = makeTempProject(t);
  writeMinimalProject(unpinnedDir, {
    composeContent: 'services:\n  db:\n    image: postgres:16-alpine\n',
  });
  assert.throws(() => parseComposeImages(unpinnedDir), /Unpinned OCI image/);

  const bannedImgDir = makeTempProject(t);
  writeMinimalProject(bannedImgDir, {
    composeContent: `services:\n  broker:\n    image: emqx/emqx:5.8.0@sha256:${'b'.repeat(64)}\n`,
  });
  assert.throws(() => parseComposeImages(bannedImgDir), /Banned dependency\/image/);

  const thingsboardDir = makeTempProject(t);
  writeMinimalProject(thingsboardDir, {
    composeContent: `services:\n  iot:\n    image: thingsboard/tb-postgres:3.8@sha256:${'c'.repeat(64)}\n`,
  });
  assert.throws(() => parseComposeImages(thingsboardDir), /Banned dependency\/image/);

  const bslDir = makeTempProject(t);
  writeMinimalProject(bslDir, {
    authLock: {
      name: '@latticedx/plugin-enterprise-auth',
      lockfileVersion: 3,
      packages: {
        'node_modules/proprietary-core': {
          version: '1.0.0',
          license: 'BSL-1.1',
          integrity: 'sha512-test',
        },
      },
    },
  });
  assert.throws(() => generateSbom({ rootDir: bslDir }), /Banned license/);
});

test('runSbomCli supports --out, --check, drift detection, and --json', (t) => {
  const dir = makeTempProject(t);
  writeMinimalProject(dir);

  const outRel = 'docs/sbom-cyclonedx.json';
  runSbomCli(['--root=' + dir, '--out=' + outRel]);
  const writtenPath = join(dir, outRel);
  assert.equal(existsSync(writtenPath), true);

  const checkResult = runSbomCli(['--root=' + dir, '--out=' + outRel, '--check']);
  assert.equal(checkResult.mode, 'check');

  // Simulate drift
  const mutated = readFileSync(writtenPath, 'utf8').replace('"1.0.0"', '"0.9.9"');
  writeFileSync(writtenPath, mutated, 'utf8');
  assert.throws(() => runSbomCli(['--root=' + dir, '--out=' + outRel, '--check']), /SBOM drift detected/);

  // Re-generate clean BOM
  runSbomCli(['--root=' + dir, '--out=' + outRel, '--json']);
  const finalCheck = runSbomCli(['--root=' + dir, '--out=' + outRel, '--check', '--json']);
  assert.equal(finalCheck.bom.specVersion, '1.5');
});
