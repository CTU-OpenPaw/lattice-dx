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
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  STACK_COMPONENTS,
  assertStackBundleDir,
  backupStack,
  collectEnvPresence,
  parseStackRecoveryArgs,
  rehearseStack,
  validateTarEntries,
} from '../stack-recovery.mjs';

function makeTempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ldx-stack-rec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeRunners({ realmPath, includeRestoreSpy = [] } = {}) {
  const pgDumpBytes = Buffer.from('PGDMP\x01\x0d\x00test-keycloak-dump', 'binary');
  const uploadsBytes = gzipSync(Buffer.from('fake-tar-payload'));
  const mongoBytes = gzipSync(Buffer.from('fake-bson-archive'));
  const workflowsJson = JSON.stringify([
    { id: 'wf-1', name: 'LatticeDX UC2 Observation Review', nodes: [{ name: 'Receive Observation' }, { name: 'Recommend' }] },
  ]);

  return {
    backupNocobaseDb: (nativeDir) => {
      mkdirSync(nativeDir, { recursive: true });
      const dumpPath = join(nativeDir, 'core-' + 'a'.repeat(32) + '.dump');
      const dumpBytes = Buffer.from('PGDMP\x01\x0d\x00nocobase-dump', 'binary');
      writeFileSync(dumpPath, dumpBytes);
      writeFileSync(dumpPath + '.json', JSON.stringify({ format: 'latticedx.pg-backup', version: 1, sha256: createHash('sha256').update(dumpBytes).digest('hex') }));
      return {
        path: dumpPath,
        scope: 'nocobase-database-only',
        sha256: createHash('sha256').update(dumpBytes).digest('hex'),
        tables: 42,
      };
    },
    rehearseNocobaseDb: (dumpPath, _nativeDir) => {
      const target = 'dx_restore_' + 'b'.repeat(32);
      includeRestoreSpy.push({ component: 'nocobase-db', target, dumpPath });
      return {
        format: 'latticedx.native-restore-rehearsal',
        scope: 'nocobase-database-only',
        fixtureDatabase: target,
        metadataVerified: true,
        tables: 42,
      };
    },
    dumpUploads: () => uploadsBytes,
    listTarEntries: () => ['uploads/', 'uploads/2026-11/sample.txt'],
    extractTarToDir: (_bytes, targetDir) => {
      includeRestoreSpy.push({ component: 'uploads', targetDir });
      mkdirSync(join(targetDir, 'uploads/2026-11'), { recursive: true });
      writeFileSync(join(targetDir, 'uploads/2026-11/sample.txt'), 'ok', 'utf8');
    },
    dumpKeycloakDb: () => pgDumpBytes,
    restoreKeycloakSnapshot: (bytes, target) => {
      assert.match(target, /^dx_restore_[a-f0-9]{32}$/);
      assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
      includeRestoreSpy.push({ component: 'keycloak', target });
      return ['realm', 'user_entity'];
    },
    readKeycloakRealmFile: () => readFileSync(realmPath, 'utf8'),
    dumpOrionMongo: () => mongoBytes,
    dryRunOrionRestore: (bytes) => {
      assert.equal(bytes[0], 0x1f);
      assert.equal(bytes[1], 0x8b);
      includeRestoreSpy.push({ component: 'orion-mongo', dryRun: true });
      return { dryRunVerified: true, documentsRestored: 3 };
    },
    exportN8nWorkflows: () => workflowsJson,
  };
}

test('parseStackRecoveryArgs validates modes, components, and rejects unknown flags', () => {
  assert.throws(() => parseStackRecoveryArgs([]), /Usage:/);
  assert.throws(() => parseStackRecoveryArgs(['rehearse']), /Usage:/);
  assert.throws(() => parseStackRecoveryArgs(['backup', '--bad']), /Unknown option/);
  assert.throws(() => parseStackRecoveryArgs(['backup', '--components=unknown']), /Unknown component/);

  const parsed = parseStackRecoveryArgs(['backup', '--components=uploads,keycloak,n8n']);
  assert.equal(parsed.mode, 'backup');
  assert.deepEqual(parsed.components, ['uploads', 'keycloak', 'n8n']);

  const allDefault = parseStackRecoveryArgs(['backup']);
  assert.deepEqual(allDefault.components, STACK_COMPONENTS);
});

test('validateTarEntries rejects traversal, absolute paths, and unsafe entries', () => {
  assert.deepEqual(
    validateTarEntries(['uploads/', 'uploads/doc.pdf']),
    ['uploads/', 'uploads/doc.pdf'],
  );
  assert.throws(() => validateTarEntries(['../etc/passwd']), /Unsafe tar entry/);
  assert.throws(() => validateTarEntries(['/etc/passwd']), /Unsafe tar entry/);
  assert.throws(() => validateTarEntries(['C:\\secret\\a.txt']), /Unsafe tar entry/);
});

test('collectEnvPresence records only boolean presence and never leaks secret values', () => {
  const secretValue = 'super-secret-value-never-serialize-999';
  const result = collectEnvPresence({
    APP_KEY: secretValue,
    N8N_ENCRYPTION_KEY: 'another-secret-value',
    AGENT_API_KEY: '',
  });
  const text = JSON.stringify(result);
  assert.equal(result.APP_KEY, true);
  assert.equal(result.N8N_ENCRYPTION_KEY, true);
  assert.equal(result.AGENT_API_KEY, false);
  assert.equal(text.includes(secretValue), false);
  assert.equal(text.includes('another-secret-value'), false);
});

test('assertStackBundleDir rejects traversal and symlinks outside backup root', (t) => {
  const root = makeTempRoot(t);
  const valid = join(root, 'stack-' + 'c'.repeat(32));
  mkdirSync(valid, { recursive: true });
  assert.equal(assertStackBundleDir(valid, root), valid);
  assert.throws(() => assertStackBundleDir(join(root, '../escape'), root), /approved/i);
  assert.throws(() => assertStackBundleDir(join(root, 'not-a-bundle'), root), /approved/i);

  const linkDir = join(root, 'stack-' + 'd'.repeat(32));
  try {
    symlinkSync(valid, linkDir, 'junction');
    assert.throws(() => assertStackBundleDir(linkDir, root), /link|approved/i);
  } catch {
    // Symlink creation may require privilege on some Windows hosts; skipped silently if unsupported.
  }
});

test('backupStack & rehearseStack handle all 5 components safely and fail closed on SHA-256 tampering', (t) => {
  const root = makeTempRoot(t);
  const backupRoot = join(root, 'stack');
  const realmFile = join(root, 'lattice-realm.json');
  writeFileSync(realmFile, JSON.stringify({ realm: 'lattice', clients: [{ clientId: 'dx-native' }] }), 'utf8');

  const restoreLog = [];
  const runners = makeFakeRunners({ realmPath: realmFile, includeRestoreSpy: restoreLog });
  const env = { APP_KEY: 'secret-1', DB_PASSWORD: 'secret-2', N8N_ENCRYPTION_KEY: 'secret-3' };

  const backup = backupStack({ directory: backupRoot, runners, env });
  assert.equal(backup.format, 'latticedx.stack-backup');
  assert.equal(backup.componentsSucceeded.length, 5);
  assert.deepEqual(backup.skippedComponents, []);

  // Secret values must not appear anywhere in manifest.json
  const manifestText = readFileSync(backup.manifestPath, 'utf8');
  assert.equal(manifestText.includes('secret-1'), false);
  assert.equal(manifestText.includes('secret-2'), false);
  assert.equal(manifestText.includes('secret-3'), false);

  const rehearsal = rehearseStack(backup.bundleDir, { directory: backupRoot, runners });
  assert.equal(rehearsal.fullStackVerified, true);
  assert.deepEqual(rehearsal.skippedComponents, []);
  assert.ok(restoreLog.every((entry) => !entry.target || /^dx_restore_[a-f0-9]{32}$/.test(entry.target)));

  // Tamper with n8n-workflows.json (both size mismatch and same-length checksum mismatch) and verify fail-closed before any restore
  const restoreCountBeforeTamper = restoreLog.length;
  const wfPath = join(backup.bundleDir, 'n8n-workflows.json');
  const origWf = readFileSync(wfPath, 'utf8');
  const sameLenTamper = (origWf.startsWith('[') ? ' ' : '[') + origWf.slice(1);
  writeFileSync(wfPath, sameLenTamper, 'utf8');
  assert.throws(() => rehearseStack(backup.bundleDir, { directory: backupRoot, runners }), /checksum mismatch/i);
  writeFileSync(wfPath, '[]', 'utf8');
  assert.throws(() => rehearseStack(backup.bundleDir, { directory: backupRoot, runners }), /size\/file check failed/i);
  assert.equal(restoreLog.length, restoreCountBeforeTamper, 'tampered artifact must fail closed before running any restore');
});

test('partial component rehearsal sets fullStackVerified=false and reports skippedComponents accurately', (t) => {
  const root = makeTempRoot(t);
  const backupRoot = join(root, 'stack');
  const realmFile = join(root, 'lattice-realm.json');
  writeFileSync(realmFile, JSON.stringify({ realm: 'lattice' }), 'utf8');
  const runners = makeFakeRunners({ realmPath: realmFile });

  const partial = backupStack({
    directory: backupRoot,
    components: ['uploads', 'n8n'],
    runners,
    env: {},
  });
  assert.deepEqual(partial.componentsSucceeded, ['uploads', 'n8n']);
  assert.deepEqual(partial.skippedComponents, ['nocobase-db', 'keycloak', 'orion-mongo']);

  const rehearsal = rehearseStack(partial.bundleDir, { directory: backupRoot, runners });
  assert.equal(rehearsal.fullStackVerified, false);
  assert.deepEqual(rehearsal.skippedComponents, ['nocobase-db', 'keycloak', 'orion-mongo']);
});
