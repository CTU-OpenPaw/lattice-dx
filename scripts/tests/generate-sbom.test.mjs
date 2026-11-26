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
  resolveOciImageLicense,
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
      '': { name: '@latticedx/plugin-enterprise-auth', version: '0.4.0' },
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
    version: '0.4.0',
    license: rootLicense,
  }, null, 2));
  mkdirSync(join(dir, 'plugins', 'nocobase', 'plugin-lattice-foundation'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'nocobase', 'plugin-lattice-foundation', 'package.json'), JSON.stringify({
    name: '@latticedx/plugin-lattice-foundation',
    version: '0.4.0',
    license: 'Apache-2.0',
  }, null, 2));
  mkdirSync(join(dir, 'plugins', 'nocobase', 'plugin-enterprise-auth'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'nocobase', 'plugin-enterprise-auth', 'package.json'), JSON.stringify({
    name: '@latticedx/plugin-enterprise-auth',
    version: '0.4.0',
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
  assert.equal(first.bom.metadata.component.version, '0.4.0');
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
    assert.ok(Array.isArray(img.licenses) && img.licenses.length > 0, `Missing OCI license on ${img.name}`);
  }

  const byName = new Map(first.bom.components.map((c) => [`${c.name}@${c.version}`, c]));
  const workspaceComps = first.bom.components.filter((c) =>
    c.properties?.some((p) => p.name === 'latticedx:category' && ['workspace-app', 'workspace-package', 'nocobase-plugin'].includes(p.value)),
  );
  assert.equal(workspaceComps.length, 12);
  for (const wsComp of workspaceComps) {
    assert.equal(wsComp.version, '0.4.0', `Expected workspace component ${wsComp.name} to be 0.4.0`);
    assert.equal(wsComp.licenses?.[0]?.license?.id, 'Apache-2.0');
  }

  const npmDeps = first.bom.components.filter((c) => c.properties?.some((p) => p.name === 'latticedx:category' && p.value === 'npm-dependency'));
  const npmWithLicenses = npmDeps.filter((c) => Array.isArray(c.licenses) && c.licenses.length > 0);
  assert.equal(npmWithLicenses.length, npmDeps.length, `Expected all npm dependencies to resolve licenses, got ${npmWithLicenses.length}/${npmDeps.length}`);
  assert.equal(byName.get('fsevents@2.3.3')?.licenses?.[0]?.license?.id, 'MIT');
  assert.equal(byName.get('@esbuild/linux-x64@0.28.2')?.licenses?.[0]?.license?.id, 'MIT');
  assert.equal(byName.get('typescript@7.0.2')?.licenses?.[0]?.license?.id, 'Apache-2.0');
  assert.equal(byName.get('lightningcss@1.33.0')?.licenses?.[0]?.license?.id, 'MPL-2.0');

  const postgresImg = ociImages.find((c) => c.name.startsWith('postgres:'));
  assert.equal(postgresImg?.licenses?.[0]?.license?.id, 'PostgreSQL');
  const mosquittoImg = ociImages.find((c) => c.name.startsWith('eclipse-mosquitto:'));
  assert.equal(mosquittoImg?.licenses?.[0]?.expression, 'EPL-2.0 OR BSD-3-Clause');
  const valkeyImg = ociImages.find((c) => c.name.startsWith('valkey/valkey:'));
  assert.equal(valkeyImg?.licenses?.[0]?.license?.id, 'BSD-3-Clause');
  assert.equal(resolveOciImageLicense('valkey/valkey', '8.1-alpine')?.value, 'BSD-3-Clause');
  const n8nImg = ociImages.find((c) => c.name.startsWith('n8nio/n8n:'));
  assert.equal(n8nImg?.licenses?.[0]?.license?.name, 'Sustainable Use License');
});

test('generateSbom resolves npm licenses from node_modules / .pnpm, rejects BSL-1.1 in node_modules, and falls back gracefully when node_modules is absent', (t) => {
  // 1. Without node_modules: falls back gracefully while preserving OCI, lockfile, and curated platform-optional licenses
  const noNmDir = makeTempProject(t);
  writeMinimalProject(noNmDir, {
    pnpmLockContent: [
      "lockfileVersion: '9.0'",
      'packages:',
      '',
      '  fsevents@2.3.3:',
      '    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}',
      '    os: [darwin]',
      '    optional: true',
      '',
      '  zod@3.24.2:',
      '    resolution: {integrity: sha512-2kJm+q0S0vP9v4fK5v7z7Q==}',
      '',
      'snapshots:',
      '',
    ].join('\n'),
  });
  const noNmBom = generateSbom({ rootDir: noNmDir }).bom;
  const fseventsNoNm = noNmBom.components.find((c) => c.name === 'fsevents' && c.version === '2.3.3');
  assert.equal(fseventsNoNm?.licenses?.[0]?.license?.id, 'MIT');
  const zodNoNm = noNmBom.components.find((c) => c.name === 'zod');
  assert.equal(zodNoNm?.licenses, undefined);
  const pgNoNm = noNmBom.components.find((c) => c.type === 'container');
  assert.equal(pgNoNm?.licenses?.[0]?.license?.id, 'PostgreSQL');

  // 2. With node_modules/.pnpm + cross-platform sibling + plugin node_modules
  const withNmDir = makeTempProject(t);
  writeMinimalProject(withNmDir, {
    pnpmLockContent: [
      "lockfileVersion: '9.0'",
      'packages:',
      '',
      '  zod@3.24.2:',
      '    resolution: {integrity: sha512-2kJm+q0S0vP9v4fK5v7z7Q==}',
      '',
      "  '@esbuild/linux-x64@0.28.2':",
      '    resolution: {integrity: sha512-1kJm+q0S0vP9v4fK5v7z7Q==}',
      '',
      "  '@esbuild/win32-x64@0.28.2':",
      '    resolution: {integrity: sha512-3kJm+q0S0vP9v4fK5v7z7Q==}',
      '',
      '  openid-client@6.8.9:',
      '    resolution: {integrity: sha512-4kJm+q0S0vP9v4fK5v7z7Q==}',
      '',
      'snapshots:',
      '',
    ].join('\n'),
  });
  const zodPkgDir = join(withNmDir, 'node_modules', '.pnpm', 'zod@3.24.2', 'node_modules', 'zod');
  mkdirSync(zodPkgDir, { recursive: true });
  writeFileSync(join(zodPkgDir, 'package.json'), JSON.stringify({ name: 'zod', version: '3.24.2', license: 'MIT' }));

  const esbuildWinDir = join(withNmDir, 'node_modules', '.pnpm', '@esbuild+win32-x64@0.28.2', 'node_modules', '@esbuild', 'win32-x64');
  mkdirSync(esbuildWinDir, { recursive: true });
  writeFileSync(join(esbuildWinDir, 'package.json'), JSON.stringify({ name: '@esbuild/win32-x64', version: '0.28.2', license: 'MIT' }));

  const pluginNmDir = join(withNmDir, 'plugins', 'nocobase', 'plugin-enterprise-auth', 'node_modules', 'openid-client');
  mkdirSync(pluginNmDir, { recursive: true });
  writeFileSync(join(pluginNmDir, 'package.json'), JSON.stringify({ name: 'openid-client', version: '6.8.9', license: 'MIT' }));

  const resolvedBom = generateSbom({ rootDir: withNmDir }).bom;
  assert.equal(resolvedBom.components.find((c) => c.name === 'zod')?.licenses?.[0]?.license?.id, 'MIT');
  assert.equal(resolvedBom.components.find((c) => c.name === '@esbuild/win32-x64')?.licenses?.[0]?.license?.id, 'MIT');
  assert.equal(resolvedBom.components.find((c) => c.name === '@esbuild/linux-x64')?.licenses?.[0]?.license?.id, 'MIT');
  assert.equal(resolvedBom.components.find((c) => c.name === 'openid-client')?.licenses?.[0]?.license?.id, 'MIT');

  // 3. Rejects BSL-1.1 declared inside installed node_modules manifest
  const bannedNmDir = makeTempProject(t);
  writeMinimalProject(bannedNmDir);
  const badZodDir = join(bannedNmDir, 'node_modules', '.pnpm', 'zod@3.24.2', 'node_modules', 'zod');
  mkdirSync(badZodDir, { recursive: true });
  writeFileSync(join(badZodDir, 'package.json'), JSON.stringify({ name: 'zod', version: '3.24.2', license: 'BSL-1.1' }));
  assert.throws(() => generateSbom({ rootDir: bannedNmDir }), /Banned license/);

  // 4. Verify timescale non-oss vs oss tag license resolution
  assert.equal(resolveOciImageLicense('timescale/timescaledb', '2.19.3-pg16-oss')?.value, 'Apache-2.0');
  assert.equal(resolveOciImageLicense('timescale/timescaledb', '2.19.3-pg16')?.value, 'Timescale License (TSL)');
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
  const mutated = readFileSync(writtenPath, 'utf8').replace('"0.4.0"', '"0.9.9"');
  writeFileSync(writtenPath, mutated, 'utf8');
  assert.throws(() => runSbomCli(['--root=' + dir, '--out=' + outRel, '--check']), /SBOM drift detected/);

  // Re-generate clean BOM
  runSbomCli(['--root=' + dir, '--out=' + outRel, '--json']);
  const finalCheck = runSbomCli(['--root=' + dir, '--out=' + outRel, '--check', '--json']);
  assert.equal(finalCheck.bom.specVersion, '1.5');
});
