/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ENTRIES = [
  'LICENSE',
  'NOTICE',
  'COPYRIGHT.txt',
  'README.md',
  'CHANGELOG.md',
  'docs/build-from-source.md',
];
const FORBIDDEN_ENTRY_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)output(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env($|\.(?!example$))/i,
  /\.(pem|key)$/i,
  /(^|\/)upstream(\/|$)/,
  /(^|\/)\.gitmodules$/,
];

export function planTarball({
  rootDir = resolve(fileURLToPath(import.meta.url), '../..'),
  version,
  ref = 'HEAD',
  outPath,
} = {}) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const resolvedVersion = version || pkg.version;
  if (!resolvedVersion || !/^[0-9A-Za-z._-]+$/.test(resolvedVersion)) {
    throw new Error('Invalid release version');
  }
  if (typeof ref !== 'string' || !ref.trim() || ref.trim().startsWith('-')) {
    throw new Error('Invalid git ref');
  }
  const target = outPath
    ? resolve(rootDir, outPath)
    : resolve(rootDir, `output/release/latticedx-${resolvedVersion}-src.tar.gz`);
  if (!target.endsWith('.tar.gz')) {
    throw new Error(`Release archive must use .tar.gz format, got: ${target}`);
  }
  return {
    rootDir,
    version: resolvedVersion,
    ref: ref.trim(),
    prefix: `latticedx-${resolvedVersion}/`,
    tarballPath: target,
    sha256Path: `${target}.sha256`,
  };
}

export function assertTarballEntries(entries, { prefix = '' } = {}) {
  const normalized = entries
    .map(item => item.replace(/\\/g, '/').trim())
    .filter(Boolean)
    .map(item => (prefix && item.startsWith(prefix) ? item.slice(prefix.length) : item));
  const entrySet = new Set(normalized);
  const missing = REQUIRED_ENTRIES.filter(req => !entrySet.has(req));
  if (missing.length) {
    throw new Error(`Release tarball missing required files: ${missing.join(', ')}`);
  }
  const forbidden = normalized.filter(entry => FORBIDDEN_ENTRY_PATTERNS.some(re => re.test(entry)));
  if (forbidden.length) {
    throw new Error(`Release tarball contains forbidden paths: ${forbidden.slice(0, 5).join(', ')}`);
  }
  return normalized;
}

export function buildOssReleaseTarball(options = {}) {
  const plan = planTarball(options);
  mkdirSync(dirname(plan.tarballPath), { recursive: true });
  const resolvedSha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${plan.ref}^{commit}`],
    { cwd: plan.rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const tmpTarball = `${plan.tarballPath}.tmp`;
  let entries;
  try {
    execFileSync(
      'git',
      ['archive', '--format=tar.gz', `--prefix=${plan.prefix}`, '-o', tmpTarball, resolvedSha],
      { cwd: plan.rootDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const listing = execFileSync('tar', ['-tzf', tmpTarball], {
      cwd: plan.rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entries = assertTarballEntries(listing.split(/\r?\n/), { prefix: plan.prefix });
    renameSync(tmpTarball, plan.tarballPath);
  } catch (error) {
    try { unlinkSync(tmpTarball); } catch {}
    throw error;
  }
  const digest = createHash('sha256').update(readFileSync(plan.tarballPath)).digest('hex');
  writeFileSync(plan.sha256Path, `${digest}  ${basename(plan.tarballPath)}\n`, 'utf8');
  return {
    result: 'PASS',
    version: plan.version,
    ref: plan.ref,
    resolvedSha,
    tarballPath: plan.tarballPath,
    sha256Path: plan.sha256Path,
    sha256: digest,
    entryCount: entries.length,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith('--out=')) opts.outPath = arg.slice('--out='.length);
    else if (arg.startsWith('--ref=')) opts.ref = arg.slice('--ref='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildOssReleaseTarball(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ result: 'FAIL', error: error.message }));
    process.exitCode = 1;
  }
}
