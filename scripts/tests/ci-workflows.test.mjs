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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('ci.yml includes check, dependency-audit, compose-validate (all 7 stacks), and trivy-scan jobs with least-privilege permissions', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(ci, /permissions:\s*\r?\n\s*contents:\s*read/);
  for (const job of ['check:', 'dependency-audit:', 'compose-validate:', 'trivy-scan:']) {
    assert.ok(ci.includes(job), `ci.yml missing job ${job}`);
  }
  assert.match(ci, /pnpm audit --prod --audit-level=high/);
  assert.match(ci, /node scripts\/source-headers\.mjs --check/);
  assert.match(ci, /tests\/nocobase-externals\.test\.mjs/);
  assert.match(ci, /aquasecurity\/trivy-action@0\.30\.0/);
  assert.match(ci, /ignore-unfixed:\s*true/);
  assert.match(ci, /exit-code:\s*'1'/);
  for (const composeFile of [
    'infra/compose/core.yml',
    'infra/compose/nocobase.yml',
    'infra/compose/native-rehearsal.yml',
    'infra/compose/integration.yml',
    'infra/compose/native-files.yml',
    'infra/compose/uc1-sample.yml',
    'infra/compose/prod.yml',
  ]) {
    assert.ok(ci.includes(composeFile), `compose-validate missing ${composeFile}`);
  }
  assert.match(ci, /--env-file\s+infra\/compose\/prod\.env\.example/);
});

test('codeql.yml runs CodeQL javascript-typescript analysis with required security-events permissions', () => {
  assert.equal(existsSync(join(ROOT, '.github/workflows/codeql.yml')), true, 'Missing .github/workflows/codeql.yml');
  const codeql = read('.github/workflows/codeql.yml');
  assert.match(codeql, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(codeql, /security-events:\s*write/);
  assert.match(codeql, /schedule:/);
  assert.match(codeql, /github\/codeql-action\/init@v3/);
  assert.match(codeql, /javascript-typescript/);
  assert.match(codeql, /github\/codeql-action\/analyze@v3/);
});
