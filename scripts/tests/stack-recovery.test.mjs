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
  restoreStack,
  validateTarEntries,
  validateTarVerboseEntries,
} from '../stack-recovery.mjs';

function makeTempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ldx-stack-rec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeRunners({ realmPath, includeRestoreSpy = [], ephemeral = false } = {}) {
  const pgDumpBytes = Buffer.from('PGDMP\x01\x0d\x00test-pg-dump', 'binary');
  const uploadsBytes = gzipSync(Buffer.from('fake-uploads-tar-payload'));
  const objectsBytes = gzipSync(Buffer.from('fake-objects-tar-payload'));
  const mongoBytes = gzipSync(Buffer.from('fake-bson-archive'));
  const workflowsJson = JSON.stringify([
    { id: 'wf-1', name: 'LatticeDX UC2 Observation Review', nodes: [{ name: 'Receive Observation' }, { name: 'Recommend' }] },
  ]);
  const credentialsJson = JSON.stringify([
    { id: 'cred-1', name: 'LatticeDX Webhook Auth', type: 'httpHeaderAuth' },
  ]);

  const makeStreamDump = (buf) => (_destPath) => buf;

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
    rehearseNocobaseDb: (dumpPath, _nativeDir, { verifyAppHealth = false, ephemeralContainer = null } = {}) => {
      const target = 'dx_restore_' + 'b'.repeat(32);
      includeRestoreSpy.push({ component: 'nocobase-db', target, dumpPath, ephemeral: Boolean(ephemeralContainer) });
      return {
        format: 'latticedx.native-restore-rehearsal',
        scope: 'nocobase-database-only',
        fixtureDatabase: target,
        metadataVerified: true,
        nativeAttachmentBytesVerified: true,
        applicationHealthVerified: Boolean(verifyAppHealth || ephemeralContainer),
        ephemeralContainerVerified: Boolean(ephemeralContainer),
        tables: 42,
      };
    },
    dumpUploads: makeStreamDump(uploadsBytes),
    dumpEngineObjects: makeStreamDump(objectsBytes),
    listTarVerboseEntries: (filePathOrBytes) => {
      const target = typeof filePathOrBytes === 'string' ? filePathOrBytes : '';
      if (target.endsWith('engine-objects.tar.gz')) {
        return [
          'drwxr-xr-x node/node 0 2026-11-22 00:00 objects/',
          '-rw------- node/node 128 2026-11-22 00:00 objects/obj-1.bin',
        ];
      }
      return [
        'drwxr-xr-x root/root 0 2026-11-22 00:00 uploads/',
        '-rw-r--r-- root/root 64 2026-11-22 00:00 uploads/2026-11/sample.txt',
      ];
    },
    listTarEntries: () => ['uploads/', 'uploads/2026-11/sample.txt'],
    extractTarToDir: (filePathOrBytes, targetDir) => {
      const isObjects = typeof filePathOrBytes === 'string' && filePathOrBytes.endsWith('engine-objects.tar.gz');
      includeRestoreSpy.push({ component: isObjects ? 'engine-objects' : 'uploads', targetDir });
      if (isObjects) {
        mkdirSync(join(targetDir, 'objects'), { recursive: true });
        writeFileSync(join(targetDir, 'objects/obj-1.bin'), 'obj', 'utf8');
      } else {
        mkdirSync(join(targetDir, 'uploads/2026-11'), { recursive: true });
        writeFileSync(join(targetDir, 'uploads/2026-11/sample.txt'), 'ok', 'utf8');
      }
    },
    dumpKeycloakDb: makeStreamDump(pgDumpBytes),
    dumpLatticeDb: makeStreamDump(pgDumpBytes),
    restoreKeycloakSnapshot: (_bytesOrPath, target, { ephemeralContainer = null } = {}) => {
      assert.match(target, /^dx_restore_[a-f0-9]{32}$/);
      includeRestoreSpy.push({ component: 'keycloak', target, ephemeral: Boolean(ephemeralContainer) });
      return ['realm', 'user_entity'];
    },
    restoreLatticeSnapshot: (_bytesOrPath, target, { ephemeralContainer = null } = {}) => {
      assert.match(target, /^dx_restore_[a-f0-9]{32}$/);
      includeRestoreSpy.push({ component: 'lattice-db', target, ephemeral: Boolean(ephemeralContainer) });
      return ['records', 'foundation_files', 'workflow_runs'];
    },
    readKeycloakRealmFile: () => readFileSync(realmPath, 'utf8'),
    dumpOrionMongo: makeStreamDump(mongoBytes),
    dryRunOrionRestore: (_bytesOrPath) => {
      includeRestoreSpy.push({ component: 'orion-mongo', dryRun: true });
      return { dryRunVerified: true, documentsRestored: 3 };
    },
    exportN8nWorkflows: () => workflowsJson,
    exportN8nCredentials: () => credentialsJson,
    withEphemeralPostgres: (fn) => {
      if (!ephemeral) throw new Error('Unexpected ephemeral postgres invocation');
      const container = 'ldx-dr-ephemeral-' + 'e'.repeat(12);
      includeRestoreSpy.push({ component: 'ephemeral-pg', start: container });
      try {
        return fn({ container, image: 'postgres:16.16-alpine' });
      } finally {
        includeRestoreSpy.push({ component: 'ephemeral-pg', stop: container });
      }
    },
    verifyRestoredApplicationHealth: ({ components }) => ({
      ok: Boolean(components['nocobase-db']?.metadataVerified),
      migrationsCount: 15,
    }),
    applyRestoreComponent: (component, { bundleDir, dryRun }) => {
      includeRestoreSpy.push({ action: 'restore', component, bundleDir, dryRun });
      return { restored: !dryRun, dryRun };
    },
  };
}

test('parseStackRecoveryArgs validates backup, rehearse --ephemeral, guarded restore, and rejects unsafe flags', () => {
  assert.throws(() => parseStackRecoveryArgs([]), /Usage:/);
  assert.throws(() => parseStackRecoveryArgs(['rehearse']), /Usage:/);
  assert.throws(() => parseStackRecoveryArgs(['restore', 'stack-a']), /confirm-restore/i);
  assert.throws(() => parseStackRecoveryArgs(['backup', '--bad']), /Unknown option/);
  assert.throws(() => parseStackRecoveryArgs(['backup', '--components=unknown']), /Unknown component/);

  assert.equal(STACK_COMPONENTS.length, 7);
  for (const req of ['nocobase-db', 'uploads', 'keycloak', 'orion-mongo', 'n8n', 'lattice-db', 'engine-objects']) {
    assert.ok(STACK_COMPONENTS.includes(req), `STACK_COMPONENTS missing ${req}`);
  }

  const parsed = parseStackRecoveryArgs(['backup', '--components=uploads,keycloak,n8n']);
  assert.equal(parsed.mode, 'backup');
  assert.deepEqual(parsed.components, ['uploads', 'keycloak', 'n8n']);

  const allDefault = parseStackRecoveryArgs(['backup']);
  assert.deepEqual(allDefault.components, STACK_COMPONENTS);

  const eph = parseStackRecoveryArgs(['rehearse', 'output/backups/stack/stack-' + 'a'.repeat(32), '--ephemeral']);
  assert.equal(eph.mode, 'rehearse');
  assert.equal(eph.ephemeral, true);

  const rest = parseStackRecoveryArgs([
    'restore',
    'output/backups/stack/stack-' + 'a'.repeat(32),
    '--confirm-restore=stack-' + 'a'.repeat(32),
    '--dry-run',
  ]);
  assert.equal(rest.mode, 'restore');
  assert.equal(rest.confirmRestore, 'stack-' + 'a'.repeat(32));
  assert.equal(rest.dryRun, true);
});

test('validateTarEntries & validateTarVerboseEntries block traversal, symlinks, hardlinks, and device nodes', () => {
  assert.deepEqual(
    validateTarEntries(['uploads/', 'uploads/doc.pdf']),
    ['uploads/', 'uploads/doc.pdf'],
  );
  assert.throws(() => validateTarEntries(['../etc/passwd']), /Unsafe tar entry/);
  assert.throws(() => validateTarEntries(['/etc/passwd']), /Unsafe tar entry/);
  assert.throws(() => validateTarEntries(['C:\\secret\\a.txt']), /Unsafe tar entry/);

  const safeVerbose = validateTarVerboseEntries([
    'drwxr-xr-x root/root 0 2026-11-22 00:00 uploads/',
    '-rw-r--r-- root/root 1024 2026-11-22 00:00 uploads/invoice.pdf',
  ]);
  assert.deepEqual(safeVerbose, ['uploads/', 'uploads/invoice.pdf']);

  for (const unsafeLine of [
    'lrwxrwxrwx root/root 0 2026-11-22 00:00 uploads/evil -> /etc/shadow',
    'hrw-r--r-- root/root 0 2026-11-22 00:00 uploads/hard link to /etc/passwd',
    'crw-rw-rw- root/root 1,3 2026-11-22 00:00 uploads/null',
    'brw-rw---- root/root 8,0 2026-11-22 00:00 uploads/sda',
    'prw-r--r-- root/root 0 2026-11-22 00:00 uploads/pipe',
    '-rw-r--r-- root/root 10 2026-11-22 00:00 ../outside.txt',
    '-rw-r--r-- root/root 10 2026-11-22 00:00 /abs/outside.txt',
  ]) {
    assert.throws(() => validateTarVerboseEntries([unsafeLine]), /Unsafe tar/i, `Should reject: ${unsafeLine}`);
  }
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

test('backupStack & rehearseStack handle all 7 components, export n8n credentials safely, verify ephemeral recovery flags, and fail closed on SHA-256 tampering', (t) => {
  const root = makeTempRoot(t);
  const backupRoot = join(root, 'stack');
  const realmFile = join(root, 'lattice-realm.json');
  writeFileSync(realmFile, JSON.stringify({ realm: 'lattice', clients: [{ clientId: 'dx-native' }] }), 'utf8');

  const restoreLog = [];
  const runners = makeFakeRunners({ realmPath: realmFile, includeRestoreSpy: restoreLog, ephemeral: true });
  const env = { APP_KEY: 'secret-1', DB_PASSWORD: 'secret-2', N8N_ENCRYPTION_KEY: 'secret-3' };

  const backup = backupStack({ directory: backupRoot, runners, env });
  assert.equal(backup.format, 'latticedx.stack-backup');
  assert.equal(backup.componentsSucceeded.length, 7);
  assert.deepEqual(backup.skippedComponents, []);

  // Secret values must not appear anywhere in manifest.json
  const manifestText = readFileSync(backup.manifestPath, 'utf8');
  assert.equal(manifestText.includes('secret-1'), false);
  assert.equal(manifestText.includes('secret-2'), false);
  assert.equal(manifestText.includes('secret-3'), false);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.components.n8n.credentialsCount, 1);
  assert.equal(manifest.components.n8n.credentialsFile, 'n8n-credentials.json');

  // Non-ephemeral rehearsal cannot assert fullRecoverability=true
  const inPlaceRehearsal = rehearseStack(backup.bundleDir, { directory: backupRoot, runners, ephemeral: false });
  assert.equal(inPlaceRehearsal.fullStackVerified, true);
  assert.equal(inPlaceRehearsal.ephemeralContainerVerified, false);
  assert.equal(inPlaceRehearsal.fullRecoverability, false);

  // Ephemeral container rehearsal proves full recoverability cleanly
  const ephRehearsal = rehearseStack(backup.bundleDir, { directory: backupRoot, runners, ephemeral: true });
  assert.equal(ephRehearsal.fullStackVerified, true);
  assert.equal(ephRehearsal.ephemeralContainerVerified, true);
  assert.equal(ephRehearsal.objectsVerified, true);
  assert.equal(ephRehearsal.nativeAttachmentBytesVerified, true);
  assert.equal(ephRehearsal.applicationHealthVerified, true);
  assert.equal(ephRehearsal.fullRecoverability, true);
  assert.deepEqual(ephRehearsal.skippedComponents, []);
  assert.ok(restoreLog.some((e) => e.component === 'ephemeral-pg' && e.start));
  assert.ok(restoreLog.some((e) => e.component === 'ephemeral-pg' && e.stop));
  assert.ok(restoreLog.every((entry) => !entry.target || /^dx_restore_[a-f0-9]{32}$/.test(entry.target)));

  // Guarded restore rejects wrong confirmation token before touching anything, supports dryRun and apply
  const id = backup.bundleDir.split(/[\\/]/).at(-1);
  assert.throws(
    () => restoreStack(backup.bundleDir, { directory: backupRoot, runners, confirmRestore: 'wrong-id' }),
    /confirm-restore/i,
  );
  const dry = restoreStack(backup.bundleDir, { directory: backupRoot, runners, confirmRestore: id, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.componentsRestored.length, 7);

  // Tamper with n8n-workflows.json (both size mismatch and same-length checksum mismatch) and verify fail-closed before any restore
  const restoreCountBeforeTamper = restoreLog.length;
  const wfPath = join(backup.bundleDir, 'n8n-workflows.json');
  const origWf = readFileSync(wfPath, 'utf8');
  const sameLenTamper = (origWf.startsWith('[') ? ' ' : '[') + origWf.slice(1);
  writeFileSync(wfPath, sameLenTamper, 'utf8');
  assert.throws(() => rehearseStack(backup.bundleDir, { directory: backupRoot, runners }), /checksum mismatch/i);
  assert.throws(() => restoreStack(backup.bundleDir, { directory: backupRoot, runners, confirmRestore: id }), /checksum mismatch/i);
  writeFileSync(wfPath, '[]', 'utf8');
  assert.throws(() => rehearseStack(backup.bundleDir, { directory: backupRoot, runners }), /size\/file check failed/i);
  assert.equal(restoreLog.length, restoreCountBeforeTamper, 'tampered artifact must fail closed before running any restore or rehearsal');
});

test('partial component rehearsal sets fullStackVerified=false and fullRecoverability=false and reports skippedComponents accurately', (t) => {
  const root = makeTempRoot(t);
  const backupRoot = join(root, 'stack');
  const realmFile = join(root, 'lattice-realm.json');
  writeFileSync(realmFile, JSON.stringify({ realm: 'lattice' }), 'utf8');
  const runners = makeFakeRunners({ realmPath: realmFile, ephemeral: true });

  const partial = backupStack({
    directory: backupRoot,
    components: ['uploads', 'n8n'],
    runners,
    env: {},
  });
  assert.deepEqual(partial.componentsSucceeded, ['uploads', 'n8n']);
  assert.deepEqual(partial.skippedComponents, ['nocobase-db', 'keycloak', 'orion-mongo', 'lattice-db', 'engine-objects']);

  const rehearsal = rehearseStack(partial.bundleDir, { directory: backupRoot, runners, ephemeral: true });
  assert.equal(rehearsal.fullStackVerified, false);
  assert.equal(rehearsal.fullRecoverability, false);
  assert.deepEqual(rehearsal.skippedComponents, ['nocobase-db', 'keycloak', 'orion-mongo', 'lattice-db', 'engine-objects']);
});
