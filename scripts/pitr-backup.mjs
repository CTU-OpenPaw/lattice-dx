/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const STANZA_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const S3_PREFIX_RE = /^s3:\/\/[a-z0-9][a-z0-9._-]{1,62}(?:\/[A-Za-z0-9._-]+)*\/?$/;
const POSIX_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

function assertSafePosixPath(value, label) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean || !POSIX_PATH_RE.test(clean) || clean.split('/').includes('..')) {
    throw new Error(`Invalid ${label} path`);
  }
  return clean.replace(/\/+$/, '') || '/';
}

export function parsePitrArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('Usage: node scripts/pitr-backup.mjs check-config | base-backup | list | restore-plan --target-time=<ISO8601> [--backend=wal-g|pgbackrest|local-gz] [--allow-unencrypted-local] [--execute]');
  }
  const [action, ...rest] = argv;
  if (!['check-config', 'base-backup', 'list', 'restore-plan'].includes(action)) {
    throw new Error('Usage: node scripts/pitr-backup.mjs check-config | base-backup | list | restore-plan ...');
  }
  let backend = 'wal-g';
  let targetTime = null;
  let allowUnencryptedLocal = false;
  let execute = false;

  for (const arg of rest) {
    if (arg.startsWith('--backend=')) {
      const value = arg.slice('--backend='.length);
      if (!['wal-g', 'pgbackrest', 'local-gz'].includes(value)) {
        throw new Error(`Unsupported PITR backend: ${value}`);
      }
      backend = value;
    } else if (arg.startsWith('--target-time=')) {
      const value = arg.slice('--target-time='.length).trim();
      if (!ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error('Target time must be a strict ISO-8601 timestamp');
      }
      targetTime = value;
    } else if (arg === '--allow-unencrypted-local') {
      allowUnencryptedLocal = true;
    } else if (arg === '--execute') {
      execute = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (action === 'restore-plan' && !targetTime) {
    throw new Error('restore-plan requires --target-time=<ISO8601>');
  }

  return { action, backend, targetTime, allowUnencryptedLocal, execute };
}

export function checkPitrConfig({ backend = 'wal-g', allowUnencryptedLocal = false, env = process.env } = {}) {
  if (backend === 'wal-g') {
    const prefix = typeof env?.WALG_S3_PREFIX === 'string' ? env.WALG_S3_PREFIX.trim() : '';
    if (!prefix || !S3_PREFIX_RE.test(prefix)) {
      throw new Error('Invalid or missing WALG_S3_PREFIX (expected s3://bucket/path)');
    }
    const encrypted = Boolean(
      (env?.WALG_LIBSODIUM_KEY && String(env.WALG_LIBSODIUM_KEY).trim()) ||
        (env?.WALG_LIBSODIUM_KEY_PATH && String(env.WALG_LIBSODIUM_KEY_PATH).trim()) ||
        (env?.WALG_PGP_KEY && String(env.WALG_PGP_KEY).trim()) ||
        (env?.WALG_PGP_KEY_PATH && String(env.WALG_PGP_KEY_PATH).trim()),
    );
    if (!encrypted && !allowUnencryptedLocal) {
      throw new Error('WAL-G encryption key is required unless --allow-unencrypted-local is specified');
    }
    return {
      ok: true,
      backend: 'wal-g',
      destination: prefix,
      endpointConfigured: Boolean(env?.AWS_ENDPOINT),
      encrypted,
    };
  }

  if (backend === 'pgbackrest') {
    const stanza = typeof env?.PGBACKREST_STANZA === 'string' ? env.PGBACKREST_STANZA.trim() : '';
    if (!stanza || !STANZA_RE.test(stanza)) {
      throw new Error('Invalid or missing PGBACKREST_STANZA');
    }
    const hasRepo = Boolean(
      (env?.PGBACKREST_REPO1_S3_BUCKET && String(env.PGBACKREST_REPO1_S3_BUCKET).trim()) ||
        (env?.PGBACKREST_REPO1_PATH && String(env.PGBACKREST_REPO1_PATH).trim()),
    );
    if (!hasRepo) {
      throw new Error('Missing pgBackRest repo configuration (PGBACKREST_REPO1_S3_BUCKET or PGBACKREST_REPO1_PATH)');
    }
    const encrypted = Boolean(
      env?.PGBACKREST_REPO1_CIPHER_PASS && String(env.PGBACKREST_REPO1_CIPHER_PASS).trim(),
    );
    if (!encrypted && !allowUnencryptedLocal) {
      throw new Error('pgBackRest repository encryption cipher pass is required unless --allow-unencrypted-local is specified');
    }
    return {
      ok: true,
      backend: 'pgbackrest',
      stanza,
      encrypted,
    };
  }

  if (backend === 'local-gz') {
    if (!allowUnencryptedLocal) {
      throw new Error('Local .gz WAL PITR requires --allow-unencrypted-local when using unencrypted local disk archives');
    }
    const walDir = assertSafePosixPath(
      typeof env?.PITR_WAL_DIR === 'string' && env.PITR_WAL_DIR.trim()
        ? env.PITR_WAL_DIR
        : '/var/lib/postgresql/wal-archive',
      'PITR_WAL_DIR',
    );
    const baseBackupDir = assertSafePosixPath(
      typeof env?.PITR_BASEBACKUP_DIR === 'string' && env.PITR_BASEBACKUP_DIR.trim()
        ? env.PITR_BASEBACKUP_DIR
        : '/var/lib/postgresql/basebackups',
      'PITR_BASEBACKUP_DIR',
    );
    return {
      ok: true,
      backend: 'local-gz',
      walDir,
      baseBackupDir,
      encrypted: false,
    };
  }

  throw new Error(`Unsupported PITR backend: ${backend}`);
}

export function buildPitrPlan({
  action,
  backend = 'wal-g',
  targetTime = null,
  allowUnencryptedLocal = false,
  env = process.env,
} = {}) {
  const status = checkPitrConfig({ backend, allowUnencryptedLocal, env });
  const pgData = assertSafePosixPath(
    typeof env?.PGDATA === 'string' && env.PGDATA.trim() ? env.PGDATA.trim() : '/var/lib/postgresql/data',
    'PGDATA',
  );

  if (action === 'check-config') {
    return { ...status, action };
  }

  if (backend === 'wal-g') {
    if (action === 'base-backup') {
      return { ...status, action, command: 'wal-g', args: ['backup-push', pgData] };
    }
    if (action === 'list') {
      return { ...status, action, command: 'wal-g', args: ['backup-list', '--detail', '--json'] };
    }
    if (action === 'restore-plan') {
      if (!targetTime || !ISO_TIMESTAMP_RE.test(targetTime)) {
        throw new Error('Valid --target-time is required');
      }
      return {
        ...status,
        action,
        command: 'wal-g',
        args: ['backup-fetch', pgData, 'LATEST'],
        recoveryConfig: {
          restore_command: 'wal-g wal-fetch "%f" "%p"',
          recovery_target_time: targetTime,
          recovery_target_action: 'promote',
        },
      };
    }
  }

  if (backend === 'pgbackrest') {
    const stanza = status.stanza;
    if (action === 'base-backup') {
      return { ...status, action, command: 'pgbackrest', args: [`--stanza=${stanza}`, 'backup'] };
    }
    if (action === 'list') {
      return { ...status, action, command: 'pgbackrest', args: [`--stanza=${stanza}`, '--output=json', 'info'] };
    }
    if (action === 'restore-plan') {
      if (!targetTime || !ISO_TIMESTAMP_RE.test(targetTime)) {
        throw new Error('Valid --target-time is required');
      }
      return {
        ...status,
        action,
        command: 'pgbackrest',
        args: [`--stanza=${stanza}`, '--type=time', `--target=${targetTime}`, 'restore'],
      };
    }
  }

  if (backend === 'local-gz') {
    const latestArchive = `${status.baseBackupDir}/latest/base.tar.gz`;
    if (action === 'base-backup') {
      return {
        ...status,
        action,
        command: 'pg_basebackup',
        args: ['-D', `${status.baseBackupDir}/latest`, '-Ft', '-z', '-X', 'stream', '-c', 'fast'],
      };
    }
    if (action === 'list') {
      return {
        ...status,
        action,
        command: 'find',
        args: [status.baseBackupDir, status.walDir, '-maxdepth', '2', '-type', 'f'],
      };
    }
    if (action === 'restore-plan') {
      if (!targetTime || !ISO_TIMESTAMP_RE.test(targetTime)) {
        throw new Error('Valid --target-time is required');
      }
      return {
        ...status,
        action,
        command: 'tar',
        args: ['-xzf', latestArchive, '-C', pgData],
        recoveryConfig: {
          restore_command: `gzip -dc "${status.walDir}/%f.gz" > "%p"`,
          recovery_target_time: targetTime,
          recovery_target_action: 'promote',
        },
      };
    }
  }

  throw new Error(`Unsupported PITR action: ${action}`);
}

export function runPitrCommand(argv) {
  const parsed = parsePitrArgs(argv);
  const plan = buildPitrPlan(parsed);
  if (parsed.execute && plan.command && Array.isArray(plan.args)) {
    const output = execFileSync(plan.command, plan.args, {
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...plan, executed: true, output: output.trim() };
  }
  return { ...plan, executed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runPitrCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
