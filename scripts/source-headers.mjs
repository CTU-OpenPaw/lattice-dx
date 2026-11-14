// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css',
  '.sql', '.yml', '.yaml', '.ps1', '.sh',
]);
const excluded = /(^|\/)(upstream|vendor|node_modules|dist|build|coverage|output|\.next|\.git)(\/|$)/;

export function addSourceHeader(source, path) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  let body = source.slice(bom.length);
  let shebang = '';
  if (body.startsWith('#!')) {
    const end = body.indexOf('\n');
    if (end < 0) return { status: 'review', source };
    shebang = body.slice(0, end + 1);
    body = body.slice(end + 1);
  }
  if (/^\s*\/\*\*[\s\S]*?@file\s+LatticeDX\b/.test(body)) {
    return { status: 'present', source };
  }
  if (/^(?:#|--) @file LatticeDX\b/.test(body)) {
    return { status: 'present', source };
  }

  // Only expand an existing explicit license marker. Do not infer ownership.
  const marker = /^(?:\/\/|#|--) SPDX-License-Identifier: Apache-2\.0[ \t]*(?:\r?\n|$)/;
  const found = body.match(marker);
  if (!found) return { status: 'review', source };

  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const fields = [
    '@file LatticeDX — Open Digital Enterprise Platform',
    '@author CTU-OpenPaw',
    '@license Apache-2.0',
    '@see https://github.com/CTU-OpenPaw/lattice-dx',
    'SPDX-License-Identifier: Apache-2.0',
  ];
  const extension = extname(path);
  let header;
  if (extension === '.sql') {
    header = fields.map(line => `-- ${line}`).join(nl);
  } else if (['.yaml', '.yml', '.ps1', '.sh'].includes(extension) || basename(path) === 'Dockerfile') {
    header = fields.map(line => `# ${line}`).join(nl);
  } else {
    header = ['/**', ...fields.map(line => ` * ${line}`), ' */'].join(nl);
  }

  // Keep the source after the old license line byte-for-byte unchanged.
  return {
    status: 'change',
    source: bom + shebang + header + nl + body.slice(found[0].length),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    throw new Error('Usage: node scripts/source-headers.mjs --check|--write');
  }
  const write = args[0] === '--write';
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const root = git('rev-parse', '--show-toplevel').trim();
  process.chdir(root);
  const files = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
  const dirty = new Set([
    ...git('diff', '--name-only', '-z').split('\0'),
    ...git('diff', '--cached', '--name-only', '-z').split('\0'),
  ]);
  const plans = [];
  const review = [];
  let present = 0;

  for (const path of files) {
    if (excluded.test(path) || /(?:^|\/)(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|next-env\.d\.ts)$/.test(path)) continue;
    if (!codeExtensions.has(extname(path)) && basename(path) !== 'Dockerfile') continue;
    if (!lstatSync(path).isFile()) continue;
    const source = readFileSync(path, 'utf8');
    const result = addSourceHeader(source, path);
    if (result.status === 'change') plans.push({ path, source: result.source });
    else if (result.status === 'review') review.push(path);
    else present++;
  }

  if (write) {
    const conflicts = plans.filter(plan => dirty.has(plan.path));
    if (conflicts.length) {
      throw new Error(`Commit or preserve these pending edits first: ${JSON.stringify(conflicts.map(x => x.path))}`);
    }
    for (const plan of plans) writeFileSync(plan.path, plan.source, 'utf8');
  }
  console.log(JSON.stringify({
    mode: write ? 'write' : 'check',
    changed: write ? plans.length : 0,
    wouldChange: write ? 0 : plans.length,
    alreadyPresent: present,
    needsReview: review,
  }, null, 2));
  if (!write && (plans.length || review.length)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
