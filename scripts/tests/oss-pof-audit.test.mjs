/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
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
    'LICENSE', 'NOTICE', 'COPYRIGHT.txt', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
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
  write('plugins/nocobase/plugin-lattice-foundation/README.md', '# Plugin Lattice Foundation\n');
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

test('runPofAudit requires root COPYRIGHT.txt and per-plugin README.md', t => {
  const dirNoCopy = createCompliantFixtureRepo();
  t.after(() => rmSync(dirNoCopy, { recursive: true, force: true }));
  rmSync(join(dirNoCopy, 'COPYRIGHT.txt'));
  const reportCopy = runPofAudit({ rootDir: dirNoCopy });
  assert.equal(reportCopy.result, 'FAIL');
  const copyCheck = reportCopy.checks.find(c => c.id === 'governance-files');
  assert.equal(copyCheck?.passed, false);
  assert.match(copyCheck?.details ?? '', /COPYRIGHT\.txt/);

  const dirNoReadme = createCompliantFixtureRepo();
  t.after(() => rmSync(dirNoReadme, { recursive: true, force: true }));
  rmSync(join(dirNoReadme, 'plugins/nocobase/plugin-lattice-foundation/README.md'));
  const reportReadme = runPofAudit({ rootDir: dirNoReadme });
  assert.equal(reportReadme.result, 'FAIL');
  const pluginCheck = reportReadme.checks.find(c => c.id === 'plugin-isolation');
  assert.equal(pluginCheck?.passed, false);
  assert.match(pluginCheck?.details ?? '', /README\.md/);
});

test('planTarball rejects non-.tar.gz archive extensions such as .zip', t => {
  const dir = createCompliantFixtureRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => planTarball({ rootDir: dir, outPath: 'output/release/bad.zip' }), /\.tar\.gz/);
  const plan = planTarball({ rootDir: dir });
  assert.ok(plan.tarballPath.endsWith('latticedx-0.1.0-src.tar.gz'));
  assert.equal(plan.sha256Path, `${plan.tarballPath}.sha256`);
});

test('assertTarballEntries rejects node_modules, .env, .git, .gitmodules, missing COPYRIGHT.txt, and any upstream files', () => {
  const base = ['latticedx-0.1.0/LICENSE', 'latticedx-0.1.0/NOTICE', 'latticedx-0.1.0/COPYRIGHT.txt', 'latticedx-0.1.0/README.md', 'latticedx-0.1.0/CHANGELOG.md', 'latticedx-0.1.0/docs/build-from-source.md'];
  assert.doesNotThrow(() => assertTarballEntries(base, { prefix: 'latticedx-0.1.0/' }));
  assert.throws(
    () => assertTarballEntries(base.filter(e => !e.endsWith('/COPYRIGHT.txt')), { prefix: 'latticedx-0.1.0/' }),
    /COPYRIGHT\.txt/,
  );
  for (const forbidden of [
    'latticedx-0.1.0/node_modules/pkg/index.js',
    'latticedx-0.1.0/.env',
    'latticedx-0.1.0/.git/HEAD',
    'latticedx-0.1.0/upstream/nocobase/',
    'latticedx-0.1.0/upstream/nocobase/package.json',
    'latticedx-0.1.0/.gitmodules',
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
  const report = runPofAudit({ rootDir: dir });
  assert.equal(report.result, 'PASS', JSON.stringify(report.checks));
  assert.ok(report.checks.every(check => check.passed), JSON.stringify(report.checks));
});

test('runPofAudit in a git repo fails when .gitmodules or upstream/ entries are tracked or present', t => {
  const dirGitmodules = createCompliantFixtureRepo();
  t.after(() => rmSync(dirGitmodules, { recursive: true, force: true }));
  writeFileSync(join(dirGitmodules, '.gitmodules'), '[submodule "upstream/nocobase"]\n\tpath = upstream/nocobase\n', 'utf8');
  execFileSync('git', ['add', '.gitmodules'], { cwd: dirGitmodules, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add gitmodules'], { cwd: dirGitmodules, stdio: 'ignore' });
  const gmReport = runPofAudit({ rootDir: dirGitmodules });
  assert.equal(gmReport.result, 'FAIL');
  assert.equal(gmReport.checks.find(c => c.id === 'upstream-clean')?.passed, false);

  const dirUpstreamFile = createCompliantFixtureRepo();
  t.after(() => rmSync(dirUpstreamFile, { recursive: true, force: true }));
  mkdirSync(join(dirUpstreamFile, 'upstream/nocobase'), { recursive: true });
  writeFileSync(join(dirUpstreamFile, 'upstream/nocobase/README.md'), '# Upstream\n', 'utf8');
  execFileSync('git', ['add', 'upstream/nocobase/README.md'], { cwd: dirUpstreamFile, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'track upstream file'], { cwd: dirUpstreamFile, stdio: 'ignore' });
  const upReport = runPofAudit({ rootDir: dirUpstreamFile });
  assert.equal(upReport.result, 'FAIL');
  assert.equal(upReport.checks.find(c => c.id === 'upstream-clean')?.passed, false);

  const dirEmptyUpstream = createCompliantFixtureRepo();
  t.after(() => rmSync(dirEmptyUpstream, { recursive: true, force: true }));
  mkdirSync(join(dirEmptyUpstream, 'upstream/nocobase'), { recursive: true });
  const emptyUpReport = runPofAudit({ rootDir: dirEmptyUpstream });
  assert.equal(emptyUpReport.result, 'FAIL');
  assert.equal(emptyUpReport.checks.find(c => c.id === 'upstream-clean')?.passed, false);
});

test('runPofAudit in a non-git directory detects missing SPDX, .env secrets, .gitmodules, and any upstream remnants', t => {
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

  const emptyDir = createCompliantFixtureFiles();
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
  mkdirSync(join(emptyDir, 'upstream/nocobase'), { recursive: true });
  const emptyReport = runPofAudit({ rootDir: emptyDir });
  assert.equal(emptyReport.result, 'FAIL');
  assert.equal(emptyReport.checks.find(c => c.id === 'upstream-clean')?.passed, false);

  const gmDir = createCompliantFixtureFiles();
  t.after(() => rmSync(gmDir, { recursive: true, force: true }));
  writeFileSync(join(gmDir, '.gitmodules'), '[submodule "upstream/nocobase"]\n', 'utf8');
  const gmReport = runPofAudit({ rootDir: gmDir });
  assert.equal(gmReport.result, 'FAIL');
  assert.equal(gmReport.checks.find(c => c.id === 'upstream-clean')?.passed, false);
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
