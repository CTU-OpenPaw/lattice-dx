/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXT_RE = /\.(ts|tsx|js|jsx|cjs|mjs)$/;
const IGNORED_GENERATED = new Set(['apps/web/next-env.d.ts']);
const ARCHIVE_SKIP_DIRS = new Set(['.git', 'node_modules', 'output', '.next', 'dist', '.turbo', 'coverage']);
const REQUIRED_GOVERNANCE = [
  'LICENSE',
  'NOTICE',
  'COPYRIGHT.txt',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/build-from-source.md',
  'docs/oss-pof-compliance.md',
  'docs/third-party.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
];
const PRIMARY_GOVERNANCE_DOCS = [
  'README.md',
  'COPYRIGHT.txt',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'NOTICE',
  'docs/build-from-source.md',
  'docs/oss-pof-compliance.md',
  'docs/third-party.md',
  'docs/dependency-inventory.md',
  'docs/nocobase-source-review.md',
];
const SECRET_TOKEN_RE = /(?:^|[^A-Za-z0-9_-])(sk-(?:proj-|live-|test-)?[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const IMAGE_PIN_RE = /^\s*image:\s*([^\s#]+@sha256:[a-f0-9]{64})(?:\s*(?:#.*)?)?$/;
const NOCOBASE_ATTRIBUTION_RE = /(?:https?:\/\/(?:www\.)?nocobase\.com|Powered by NocoBase)/i;

function runGit(rootDir, args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function canonicalPath(p) {
  let normalized;
  try { normalized = realpathSync(p); }
  catch { normalized = resolve(p); }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isGitWorkTree(rootDir) {
  try {
    const inside = runGit(rootDir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    if (!inside) return false;
    const toplevel = runGit(rootDir, ['rev-parse', '--show-toplevel']).trim();
    return canonicalPath(toplevel) === canonicalPath(rootDir);
  } catch {
    return false;
  }
}

function walkFilesRelative(rootDir, currentDir = rootDir, relPrefix = '') {
  if (!existsSync(currentDir)) return [];
  const results = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const insideUpstream = rel === 'upstream' || rel.startsWith('upstream/');
      if (!insideUpstream && ARCHIVE_SKIP_DIRS.has(entry.name)) continue;
      if (insideUpstream && entry.name === '.git') continue;
      results.push(...walkFilesRelative(rootDir, full, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function listLines(output) {
  return output.split(/\r?\n/).map(line => line.replace(/\\/g, '/').trim()).filter(Boolean);
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(full));
    else results.push(full);
  }
  return results;
}

function checkSpdxHeaders(rootDir, repoFiles) {
  const missing = [];
  for (const rel of repoFiles) {
    if (rel.startsWith('upstream/') || IGNORED_GENERATED.has(rel) || !CODE_EXT_RE.test(rel)) continue;
    const full = join(rootDir, rel);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    if (!readFileSync(full, 'utf8').includes('SPDX-License-Identifier: Apache-2.0')) missing.push(rel);
  }
  return { id: 'spdx-headers', passed: missing.length === 0, details: missing.length ? `Missing Apache-2.0 SPDX in: ${missing.join(', ')}` : 'All human-authored first-party code files carry SPDX-License-Identifier: Apache-2.0' };
}

function checkGovernanceFiles(rootDir) {
  const issues = [];
  for (const rel of REQUIRED_GOVERNANCE) {
    const full = join(rootDir, rel);
    if (!existsSync(full) || readFileSync(full, 'utf8').trim().length === 0) issues.push(`Missing or empty: ${rel}`);
  }
  const contributing = join(rootDir, 'CONTRIBUTING.md');
  if (existsSync(contributing) && readFileSync(contributing, 'utf8').includes('Hiện chưa có remote được cấu hình')) {
    issues.push('CONTRIBUTING.md still contains stale remote note');
  }
  for (const rel of PRIMARY_GOVERNANCE_DOCS) {
    const full = join(rootDir, rel);
    if (existsSync(full) && readFileSync(full, 'utf8').includes('TrDuy-pan3000/LatticeDX')) {
      issues.push(`Legacy repo URL TrDuy-pan3000/LatticeDX in ${rel}`);
    }
  }
  return { id: 'governance-files', passed: issues.length === 0, details: issues.length ? issues.join('; ') : 'All governance files, NOTICE, and issue templates present and clean' };
}

function checkPluginIsolation(rootDir) {
  const issues = [];
  const pluginsRoot = join(rootDir, 'plugins/nocobase');
  if (!existsSync(pluginsRoot)) {
    return { id: 'plugin-isolation', passed: false, details: 'Missing plugins/nocobase directory' };
  }
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(pluginsRoot, entry.name);
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (pkg.license !== 'Apache-2.0') issues.push(`plugins/nocobase/${entry.name}/package.json license is not Apache-2.0`);
    if (pkg.nocobase?.sdkProvidedByHost !== true) issues.push(`plugins/nocobase/${entry.name}/package.json missing nocobase.sdkProvidedByHost: true`);
    const licenseFile = join(dir, 'LICENSE');
    if (!existsSync(licenseFile) || readFileSync(licenseFile, 'utf8').trim().length === 0) {
      issues.push(`plugins/nocobase/${entry.name}/LICENSE missing or empty`);
    }
    const readmeFile = join(dir, 'README.md');
    if (!existsSync(readmeFile) || readFileSync(readmeFile, 'utf8').trim().length === 0) {
      issues.push(`plugins/nocobase/${entry.name}/README.md missing or empty`);
    }
  }
  const clientDir = join(pluginsRoot, 'plugin-lattice-foundation/src/client');
  const clientFiles = listFilesRecursive(clientDir);
  const hasAttribution = clientFiles.some(file => NOCOBASE_ATTRIBUTION_RE.test(readFileSync(file, 'utf8')));
  if (!hasAttribution) issues.push('Missing NocoBase Clause 5.2 attribution (nocobase.com / Powered by NocoBase) in plugins/nocobase/plugin-lattice-foundation/src/client/');
  return { id: 'plugin-isolation', passed: issues.length === 0, details: issues.length ? issues.join('; ') : 'All NocoBase plugins declare Apache-2.0, sdkProvidedByHost: true, LICENSE, README.md, and Clause 5.2 attribution' };
}

function checkComposeDigests(rootDir) {
  const composeDir = join(rootDir, 'infra/compose');
  if (!existsSync(composeDir)) return { id: 'compose-digests', passed: false, details: 'Missing infra/compose directory' };
  const unpinned = [];
  for (const entry of readdirSync(composeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
    const lines = readFileSync(join(composeDir, entry.name), 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (/^\s*image:/.test(line) && !IMAGE_PIN_RE.test(line)) {
        unpinned.push(`infra/compose/${entry.name}:${idx + 1} (${line.trim()})`);
      }
    });
  }
  return { id: 'compose-digests', passed: unpinned.length === 0, details: unpinned.length ? `Unpinned image(s): ${unpinned.join('; ')}` : 'All infra/compose/*.yml images are pinned with @sha256 digests' };
}

function checkUpstreamClean(rootDir, trackedFiles, { isGit = true, repoFiles = trackedFiles } = {}) {
  const issues = [];
  const isForbiddenUpstreamOrGitmodules = f => (
    f === '.gitmodules' || f.endsWith('/.gitmodules') || f === 'upstream' || f.startsWith('upstream/')
  );
  const forbiddenSet = new Set([
    ...trackedFiles.filter(isForbiddenUpstreamOrGitmodules),
    ...repoFiles.filter(isForbiddenUpstreamOrGitmodules),
  ]);
  if (forbiddenSet.size > 0) {
    issues.push(`Forbidden .gitmodules or upstream/ entries: ${[...forbiddenSet].slice(0, 5).join(', ')}`);
  }
  if (existsSync(join(rootDir, '.gitmodules'))) {
    issues.push('Forbidden .gitmodules file present');
  }
  if (existsSync(join(rootDir, 'upstream/nocobase'))) {
    issues.push('Forbidden upstream/nocobase directory present');
  } else if (!isGit && existsSync(join(rootDir, 'upstream'))) {
    issues.push('Forbidden upstream directory present');
  }
  if (isGit) {
    const dirtyUpstream = listLines(runGit(rootDir, ['status', '--porcelain', '--', 'upstream']));
    if (dirtyUpstream.length) issues.push(`Dirty upstream entries: ${dirtyUpstream.join(', ')}`);
    const trackedUpstream = listLines(runGit(rootDir, ['ls-files', 'upstream', '.gitmodules', ':(glob)**/.gitmodules']));
    if (trackedUpstream.length) issues.push(`Tracked upstream/.gitmodules entries: ${trackedUpstream.join(', ')}`);
  }
  return {
    id: 'upstream-clean',
    passed: issues.length === 0,
    details: issues.length
      ? issues.join('; ')
      : `No .gitmodules or upstream/ submodule/source entries present (${isGit ? 'git' : 'archive'} mode)`,
  };
}

function checkNoSecrets(rootDir, trackedFiles, repoFiles) {
  const issues = [];
  for (const rel of trackedFiles) {
    if (/(^|\/)\.env($|\.(?!example$))/i.test(rel) || /\.(pem|key)$/i.test(rel)) {
      issues.push(`Tracked secret/env file: ${rel}`);
    }
  }
  for (const rel of repoFiles) {
    if (rel.startsWith('upstream/')) continue;
    const full = join(rootDir, rel);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    const text = readFileSync(full, 'utf8');
    if (text.includes('\0')) continue;
    const match = text.match(SECRET_TOKEN_RE);
    if (match) issues.push(`Potential secret token in ${rel}`);
  }
  return { id: 'no-secrets', passed: issues.length === 0, details: issues.length ? issues.join('; ') : 'No tracked .env/*.pem/*.key files or secret tokens found' };
}

export function runPofAudit({ rootDir = resolve(fileURLToPath(import.meta.url), '../..') } = {}) {
  const isGit = isGitWorkTree(rootDir);
  const trackedFiles = isGit
    ? listLines(runGit(rootDir, ['ls-files']))
    : walkFilesRelative(rootDir);
  const repoFiles = isGit
    ? listLines(runGit(rootDir, ['ls-files', '--cached', '--others', '--exclude-standard']))
    : trackedFiles;
  const checks = [
    checkSpdxHeaders(rootDir, repoFiles),
    checkGovernanceFiles(rootDir),
    checkPluginIsolation(rootDir),
    checkComposeDigests(rootDir),
    checkUpstreamClean(rootDir, trackedFiles, { isGit, repoFiles }),
    checkNoSecrets(rootDir, trackedFiles, repoFiles),
  ];
  return { result: checks.every(c => c.passed) ? 'PASS' : 'FAIL', checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runPofAudit();
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}
