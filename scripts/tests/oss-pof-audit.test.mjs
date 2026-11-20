/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPofAudit } from '../verify-pof-readiness.mjs';
import { assertTarballEntries, buildOssReleaseTarball, planTarball } from '../build-oss-release-tarball.mjs';

const SPDX_COMMENT = '// SPDX-License-Identifier: Apache-2.0\n';

function createCompliantFixtureFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'pof-audit-fixture-'));
  const write = (rel, content) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  write('package.json', JSON.stringify({ name: 'fixture-dx', version: '0.1.0', license: 'Apache-2.0' }));
  for (const rel of [
    'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'docs/build-from-source.md', 'docs/oss-pof-compliance.md', 'docs/third-party.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
  ]) {
    write(rel, `# ${rel}\nValid content.\n`);
  }
  write('apps/web/next-env.d.ts', '// NOTE: This file should not be edited\n');
  write('apps/api/src/index.ts', `${SPDX_COMMENT}export const ok = true;\n`);
  write(
    'infra/compose/core.yml',
    'services:\n  postgres:\n    image: postgres:16.13-alpine@sha256:' + 'a'.repeat(64) + '\n',
  );
  write(
    'plugins/nocobase/plugin-lattice-foundation/package.json',
    JSON.stringify({ name: '@latticedx/plugin-lattice-foundation', license: 'Apache-2.0', nocobase: { sdkProvidedByHost: true } }),
  );
  write('plugins/nocobase/plugin-lattice-foundation/LICENSE', 'Apache-2.0\n');
  write(
    'plugins/nocobase/plugin-lattice-foundation/src/client/index.js',
    `${SPDX_COMMENT}export const attribution = 'https://www.nocobase.com';\n`,
  );
  return dir;
}

function createCompliantFixtureRepo() {
  const dir = createCompliantFixtureFiles();
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('runPofAudit passes on compliant repo and ignores auto-generated next-env.d.ts', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = runPofAudit({ rootDir: dir });
  assert.equal(report.result, 'PASS');
  assert.ok(report.checks.every(check => check.passed), JSON.stringify(report.checks));
});

test('runPofAudit detects missing SPDX headers, unpinned Compose images, and missing Clause 5.2 attribution', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'apps/api/src/missing.ts'), 'export const bad = 1;\n', 'utf8');
  writeFileSync(join(dir, 'infra/compose/core.yml'), 'services:\n  postgres:\n    image: postgres:16.13-alpine\n', 'utf8');
  writeFileSync(join(dir, 'plugins/nocobase/plugin-lattice-foundation/src/client/index.js'), `${SPDX_COMMENT}export const fixture = 'admin@nocobase.com';\n`, 'utf8');
  const report = runPofAudit({ rootDir: dir });
  assert.equal(report.result, 'FAIL');
  const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
  assert.equal(byId['spdx-headers'].passed, false);
  assert.match(byId['spdx-headers'].details, /apps\/api\/src\/missing\.ts/);
  assert.equal(byId['compose-digests'].passed, false);
  assert.match(byId['compose-digests'].details, /infra\/compose\/core\.yml/);
  assert.equal(byId['plugin-isolation'].passed, false);
  assert.match(byId['plugin-isolation'].details, /Clause 5\.2/);
});

test('planTarball rejects non-.tar.gz archive extensions such as .zip', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => planTarball({ rootDir: dir, outPath: 'output/release/bad.zip' }), /\.tar\.gz/);
  const plan = planTarball({ rootDir: dir });
  assert.ok(plan.tarballPath.endsWith('latticedx-0.1.0-src.tar.gz'));
  assert.equal(plan.sha256Path, `${plan.tarballPath}.sha256`);
});

test('assertTarballEntries rejects node_modules, .env, .git, and bundled upstream files', () => {
  const base = ['latticedx-0.1.0/LICENSE', 'latticedx-0.1.0/NOTICE', 'latticedx-0.1.0/README.md', 'latticedx-0.1.0/CHANGELOG.md', 'latticedx-0.1.0/docs/build-from-source.md'];
  assert.doesNotThrow(() => assertTarballEntries([...base, 'latticedx-0.1.0/upstream/nocobase/'], { prefix: 'latticedx-0.1.0/' }));
  for (const forbidden of [
    'latticedx-0.1.0/node_modules/pkg/index.js',
    'latticedx-0.1.0/.env',
    'latticedx-0.1.0/.git/HEAD',
    'latticedx-0.1.0/upstream/nocobase/package.json',
  ]) {
    assert.throws(() => assertTarballEntries([...base, forbidden], { prefix: 'latticedx-0.1.0/' }), /forbidden/);
  }
});

test('buildOssReleaseTarball generates verified .tar.gz and .sha256 sidecar from git HEAD', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = buildOssReleaseTarball({ rootDir: dir });
  assert.equal(result.result, 'PASS');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(result.sha256Path, 'utf8').trim(), `${result.sha256}  latticedx-0.1.0-src.tar.gz`);
});

test('runPofAudit passes in an extracted release directory without .git', t => {
  const dir = createCompliantFixtureFiles();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'upstream/nocobase'), { recursive: true });
  const report = runPofAudit({ rootDir: dir });
  assert.equal(report.result, 'PASS', JSON.stringify(report.checks));
  assert.ok(report.checks.every(check => check.passed), JSON.stringify(report.checks));
});

test('runPofAudit in a non-git directory detects missing SPDX, .env secrets, and bundled upstream files', t => {
  const dir = createCompliantFixtureFiles();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'upstream/nocobase'), { recursive: true });
  writeFileSync(join(dir, 'apps/api/src/missing.ts'), 'export const bad = 1;\n', 'utf8');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n', 'utf8');
  writeFileSync(join(dir, 'upstream/nocobase/package.json'), '{}', 'utf8');
  const report = runPofAudit({ rootDir: dir });
  assert.equal(report.result, 'FAIL');
  const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
  assert.equal(byId['spdx-headers'].passed, false);
  assert.equal(byId['no-secrets'].passed, false);
  assert.equal(byId['upstream-clean'].passed, false);

  const nmDir = createCompliantFixtureFiles();
  t.after(() => rmSync(nmDir, { recursive: true, force: true }));
  mkdirSync(join(nmDir, 'upstream/node_modules/pkg'), { recursive: true });
  writeFileSync(join(nmDir, 'upstream/node_modules/pkg/index.js'), 'export {};\n', 'utf8');
  const nmReport = runPofAudit({ rootDir: nmDir });
  assert.equal(nmReport.result, 'FAIL');
  assert.equal(nmReport.checks.find(c => c.id === 'upstream-clean').passed, false);
});

test('planTarball rejects unsafe git refs and buildOssReleaseTarball leaves no corrupt file on failure', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => planTarball({ rootDir: dir, ref: '--exec=evil' }), /Invalid git ref/);

  // Create a commit containing a forbidden .env file and ensure buildOssReleaseTarball fails cleanly without leaving tarball or .tmp
  writeFileSync(join(dir, '.env'), 'SECRET=1\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add forbidden env'], { cwd: dir, stdio: 'ignore' });
  const plan = planTarball({ rootDir: dir });
  assert.throws(() => buildOssReleaseTarball({ rootDir: dir }), /forbidden paths/);
  assert.equal(readFileSync(join(dir, 'package.json')).length > 0, true);
  assert.throws(() => readFileSync(plan.tarballPath), /ENOENT/);
  assert.throws(() => readFileSync(`${plan.tarballPath}.tmp`), /ENOENT/);
});
