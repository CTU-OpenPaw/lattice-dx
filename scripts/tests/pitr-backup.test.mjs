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
import {
  buildPitrPlan,
  checkPitrConfig,
  parsePitrArgs,
} from '../pitr-backup.mjs';

test('parsePitrArgs validates actions, backend flags, and strict ISO-8601 target-time', () => {
  assert.throws(() => parsePitrArgs([]), /Usage:/);
  assert.throws(() => parsePitrArgs(['destroy']), /Usage:/);
  assert.throws(() => parsePitrArgs(['check-config', '--backend=evil']), /backend/i);
  assert.throws(() => parsePitrArgs(['restore-plan']), /target-time/i);
  assert.throws(
    () => parsePitrArgs(['restore-plan', '--target-time=2026-11-22;rm -rf /']),
    /ISO-8601/i,
  );

  const plan = parsePitrArgs([
    'restore-plan',
    '--backend=pgbackrest',
    '--target-time=2026-11-22T06:00:00Z',
    '--allow-unencrypted-local',
  ]);
  assert.deepEqual(plan, {
    action: 'restore-plan',
    backend: 'pgbackrest',
    targetTime: '2026-11-22T06:00:00Z',
    allowUnencryptedLocal: true,
    execute: false,
  });
});

test('checkPitrConfig enforces encryption and S3/repo configuration fail-closed and never leaks secret values', () => {
  assert.throws(
    () => checkPitrConfig({ backend: 'wal-g', env: {} }),
    /WALG_S3_PREFIX|WAL-G/i,
  );
  assert.throws(
    () =>
      checkPitrConfig({
        backend: 'wal-g',
        env: { WALG_S3_PREFIX: 's3://lattice-dr/nocobase' },
      }),
    /encryption/i,
  );

  const validWalG = checkPitrConfig({
    backend: 'wal-g',
    env: {
      WALG_S3_PREFIX: 's3://lattice-dr/nocobase',
      WALG_LIBSODIUM_KEY: 'super-secret-libsodium-key-never-print',
      AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key-never-print',
      AWS_ENDPOINT: 'http://rustfs:9000',
    },
  });
  assert.equal(validWalG.ok, true);
  assert.equal(validWalG.encrypted, true);
  assert.equal(validWalG.backend, 'wal-g');
  const serialized = JSON.stringify(validWalG);
  assert.equal(serialized.includes('super-secret-libsodium-key-never-print'), false);
  assert.equal(serialized.includes('super-secret-aws-key-never-print'), false);

  const localPgBackRest = checkPitrConfig({
    backend: 'pgbackrest',
    allowUnencryptedLocal: true,
    env: {
      PGBACKREST_STANZA: 'latticedx',
      PGBACKREST_REPO1_PATH: '/var/lib/pgbackrest',
    },
  });
  assert.equal(localPgBackRest.ok, true);
  assert.equal(localPgBackRest.encrypted, false);
});

test('buildPitrPlan produces safe non-shell command arguments for base-backup, list, and restore-plan', () => {
  const env = {
    WALG_S3_PREFIX: 's3://lattice-dr/pg',
    WALG_PGP_KEY_PATH: '/etc/latticedx/pitr.asc',
    PGDATA: '/var/lib/postgresql/data',
  };
  const base = buildPitrPlan({ action: 'base-backup', backend: 'wal-g', env });
  assert.equal(base.command, 'wal-g');
  assert.deepEqual(base.args, ['backup-push', '/var/lib/postgresql/data']);

  const list = buildPitrPlan({ action: 'list', backend: 'wal-g', env });
  assert.deepEqual(list.args, ['backup-list', '--detail', '--json']);

  const restore = buildPitrPlan({
    action: 'restore-plan',
    backend: 'pgbackrest',
    targetTime: '2026-11-22T06:00:00Z',
    env: {
      PGBACKREST_STANZA: 'latticedx-main',
      PGBACKREST_REPO1_S3_BUCKET: 'lattice-dr',
      PGBACKREST_REPO1_CIPHER_PASS: 'top-secret-pass',
    },
  });
  assert.equal(restore.command, 'pgbackrest');
  assert.deepEqual(restore.args, [
    '--stanza=latticedx-main',
    '--type=time',
    '--target=2026-11-22T06:00:00Z',
    'restore',
  ]);
  assert.equal(JSON.stringify(restore).includes('top-secret-pass'), false);
});
