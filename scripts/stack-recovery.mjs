/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRestoreTarget,
  maxBackupBytes,
  readFileHead,
  resolveMaxStreamingBackupBytes,
  runRestoreFixture,
  sha256File,
  streamDockerToFile,
  streamFileToDocker,
} from './lib/backup-policy.mjs';
import { dockerContextArgs } from './lib/docker-context.mjs';
import { backupNative, inventorySql, rehearseNative, requiredNativeTables } from './native-database-recovery.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STACK_ROOT = join(REPO_ROOT, 'output/backups/stack');
const DEFAULT_REALM_PATH = join(REPO_ROOT, 'infra/config/keycloak/lattice-realm.json');
const DEFAULT_EPHEMERAL_PG_IMAGE =
  'postgres:16.16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const HEX32_RE = /^[a-f0-9]{32}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));

export const STACK_COMPONENTS = [
  'nocobase-db',
  'uploads',
  'keycloak',
  'orion-mongo',
  'n8n',
  'lattice-db',
  'engine-objects',
];
export const STACK_BUNDLE_FORMAT = 'latticedx.stack-backup';
export const STACK_REHEARSAL_FORMAT = 'latticedx.stack-restore-rehearsal';
export const STACK_RESTORE_FORMAT = 'latticedx.stack-restore';
export const DEFAULT_ENV_PRESENCE_KEYS = [
  'APP_KEY',
  'ENCRYPTION_FIELD_KEY',
  'DB_PASSWORD',
  'N8N_ENCRYPTION_KEY',
  'AGENT_API_KEY',
];

const normalizePath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const syncSleepMs = (ms) => {
  Atomics.wait(SLEEP_ARR, 0, 0, ms);
};

function assertSafeDir(dirPath) {
  const abs = resolve(dirPath);
  if (normalizePath(realpathSync(abs)) !== normalizePath(abs)) {
    throw new Error('Backup directory links are forbidden');
  }
  return abs;
}

function assertContainerName(value, label) {
  if (typeof value !== 'string' || !CONTAINER_RE.test(value)) {
    throw new Error(`Invalid container name for ${label}`);
  }
  return value;
}

function dockerExec(container, args, input) {
  assertContainerName(container, 'docker container');
  try {
    return execFileSync('docker', [...dockerContextArgs(), 'exec', '-i', container, ...args], {
      cwd: REPO_ROOT,
      input,
      timeout: 180000,
      maxBuffer: maxBackupBytes,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Container command failed on ${container}; output withheld`);
  }
}

function dockerExecNoStdin(container, args) {
  assertContainerName(container, 'docker container');
  try {
    return execFileSync('docker', [...dockerContextArgs(), 'exec', container, ...args], {
      cwd: REPO_ROOT,
      timeout: 180000,
      maxBuffer: maxBackupBytes,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Container command failed on ${container}; output withheld`);
  }
}

function extractJsonArray(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '[]';
  if (trimmed.startsWith('[')) return trimmed;
  const idx = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (idx >= 0 && end > idx) return trimmed.slice(idx, end + 1);
  return '[]';
}

export function parseStackRecoveryArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      'Usage: node scripts/stack-recovery.mjs backup | rehearse <bundleDir> [--ephemeral|--in-place] [--components=...] | restore <bundleDir> --confirm-restore=<stack-id> [--dry-run] [--components=...]',
    );
  }
  const [mode, ...rest] = argv;
  if (!['backup', 'rehearse', 'restore'].includes(mode)) {
    throw new Error(
      'Usage: node scripts/stack-recovery.mjs backup | rehearse <bundleDir> [--ephemeral|--in-place] [--components=...] | restore <bundleDir> --confirm-restore=<stack-id> [--dry-run] [--components=...]',
    );
  }

  let bundlePath = null;
  let components = null;
  let sawComponents = false;
  let ephemeral = false;
  let confirmRestore = null;
  let dryRun = false;

  for (const arg of rest) {
    if (arg.startsWith('--components=')) {
      if (sawComponents) throw new Error('Duplicate --components argument');
      sawComponents = true;
      const list = arg
        .slice('--components='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) throw new Error('At least one component must be specified');
      for (const item of list) {
        if (!STACK_COMPONENTS.includes(item)) throw new Error(`Unknown component: ${item}`);
      }
      components = [...new Set(list)];
    } else if (arg === '--ephemeral' && mode === 'rehearse') {
      ephemeral = true;
    } else if (arg === '--in-place' && mode === 'rehearse') {
      ephemeral = false;
    } else if (arg.startsWith('--confirm-restore=') && mode === 'restore') {
      confirmRestore = arg.slice('--confirm-restore='.length).trim();
    } else if (arg === '--dry-run' && mode === 'restore') {
      dryRun = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if ((mode === 'rehearse' || mode === 'restore') && bundlePath === null) {
      bundlePath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (mode === 'backup' && !components) {
    components = [...STACK_COMPONENTS];
  }
  if ((mode === 'rehearse' || mode === 'restore') && !bundlePath) {
    throw new Error(`Usage: node scripts/stack-recovery.mjs ${mode} <bundleDir> ...`);
  }
  if (mode === 'restore' && !confirmRestore) {
    throw new Error('Restore requires --confirm-restore=<bundle-id>');
  }

  return { mode, bundlePath, components, ephemeral, confirmRestore, dryRun };
}

export function assertStackBundleDir(bundleDir, root = DEFAULT_STACK_ROOT) {
  const absRoot = resolve(root);
  const absBundle = resolve(bundleDir);
  const rel = relative(absRoot, absBundle);
  if (
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    dirname(absBundle) !== absRoot ||
    !/^stack-[a-f0-9]{32}$/.test(basename(absBundle))
  ) {
    throw new Error('Bundle directory must be an approved stack-<id> folder inside output/backups/stack');
  }
  const st = lstatSync(absBundle);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('Bundle path must be a real directory (links forbidden)');
  }
  if (
    normalizePath(realpathSync(absRoot)) !== normalizePath(absRoot) ||
    normalizePath(realpathSync(absBundle)) !== normalizePath(absBundle)
  ) {
    throw new Error('Bundle path links are forbidden');
  }
  return absBundle;
}

export function validateTarEntries(entries, maxEntries = 20000) {
  if (!Array.isArray(entries) || entries.length > maxEntries) {
    throw new Error('Unsafe tar entry list or entry limit exceeded');
  }
  const cleaned = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') throw new Error('Unsafe tar entry: non-string');
    const entry = raw.trim();
    if (!entry) continue;
    if (
      entry.startsWith('/') ||
      entry.startsWith('\\') ||
      /^[A-Za-z]:/.test(entry) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(entry) ||
      /[\0\r\n]/.test(entry)
    ) {
      throw new Error(`Unsafe tar entry rejected: ${entry}`);
    }
    cleaned.push(entry);
  }
  return cleaned;
}

export function validateTarVerboseEntries(lines, maxEntries = 20000) {
  if (!Array.isArray(lines) || lines.length > maxEntries) {
    throw new Error('Unsafe tar verbose listing or entry limit exceeded');
  }
  const paths = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') throw new Error('Unsafe tar line: non-string');
    const line = raw.trim();
    if (!line) continue;
    if (/^[lhcbps]/i.test(line) || !/^[-d][rwxstST-]{9}/.test(line)) {
      throw new Error(`Unsafe tar entry type rejected (symlinks/hardlinks/devices forbidden): ${line}`);
    }
    if (/\s->\s|\slink to\s/i.test(line)) {
      throw new Error(`Unsafe tar link target rejected: ${line}`);
    }
    const isoMatch = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/);
    const bsdMatch = line.match(/[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/);
    const entryPath = isoMatch?.[1] ?? bsdMatch?.[1];
    if (!entryPath) {
      throw new Error(`Unrecognized tar verbose line rejected: ${line}`);
    }
    paths.push(...validateTarEntries([entryPath], 1));
  }
  return paths;
}

export function collectEnvPresence(env = process.env, keys = DEFAULT_ENV_PRESENCE_KEYS) {
  const presence = {};
  for (const key of keys) {
    presence[key] = typeof env?.[key] === 'string' && env[key].trim().length > 0;
  }
  return presence;
}

export function createDefaultRunners() {
  const nocobaseApp = assertContainerName(
    process.env.NATIVE_APP_CONTAINER ?? 'lattice-dx-nocobase-1',
    'NATIVE_APP_CONTAINER',
  );
  const nocobaseDb = assertContainerName(
    process.env.NATIVE_DATABASE_CONTAINER ?? 'lattice-dx-nocobase-db-1',
    'NATIVE_DATABASE_CONTAINER',
  );
  const apiContainer = assertContainerName(process.env.API_CONTAINER ?? 'lattice-dx-api-1', 'API_CONTAINER');
  const keycloakDb = assertContainerName(
    process.env.KEYCLOAK_DB_CONTAINER ?? 'lattice-dx-postgres-1',
    'KEYCLOAK_DB_CONTAINER',
  );
  const keycloakUser = process.env.KEYCLOAK_DB_USER ?? 'lattice';
  const keycloakDbName = process.env.KEYCLOAK_DB_NAME ?? 'keycloak';
  const latticeDb = assertContainerName(
    process.env.LATTICE_DB_CONTAINER ?? keycloakDb,
    'LATTICE_DB_CONTAINER',
  );
  const latticeUser = process.env.LATTICE_DB_USER ?? 'lattice';
  const latticeDbName = process.env.LATTICE_DB_NAME ?? 'lattice';
  const orionMongo = assertContainerName(
    process.env.ORION_MONGO_CONTAINER ?? 'lattice-dx-orion-mongo-1',
    'ORION_MONGO_CONTAINER',
  );
  const n8nContainer = assertContainerName(process.env.N8N_CONTAINER ?? 'lattice-dx-n8n-1', 'N8N_CONTAINER');
  const objectsRoot = process.env.FILE_STORAGE_ROOT ?? '/var/lib/latticedx/objects';
  const mongoUser = process.env.ORION_MONGO_USER?.trim() || '';
  const mongoPassword = process.env.ORION_MONGO_PASSWORD?.trim() || '';
  const mongoAuthArgs =
    mongoUser && mongoPassword
      ? ['--username', mongoUser, '--password', mongoPassword, '--authenticationDatabase=admin']
      : [];

  const psqlContainer = (container, user, database, statement) =>
    dockerExecNoStdin(container, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-At', '-c', statement])
      .toString()
      .trim();

  const inspectPgWalReadiness = (container, user, database, walArchiveDir) => {
    const archiveMode = psqlContainer(container, user, database, 'SHOW archive_mode;');
    const archiveCommand = psqlContainer(container, user, database, 'SHOW archive_command;');
    let walDirReady = false;
    let archiveScriptReady = false;
    try {
      dockerExecNoStdin(container, ['test', '-d', walArchiveDir]);
      walDirReady = true;
    } catch {
      walDirReady = false;
    }
    try {
      dockerExecNoStdin(container, ['test', '-r', '/etc/postgresql/pitr-archive.sh']);
      archiveScriptReady = true;
    } catch {
      archiveScriptReady = false;
    }
    return {
      archiveMode,
      archiveCommand,
      walDirReady,
      archiveScriptReady,
    };
  };

  const restorePgStream = (container, user, dumpPath, target) => {
    assertRestoreTarget(target);
    return runRestoreFixture(
      target,
      () => psqlContainer(container, user, 'postgres', `CREATE DATABASE ${target}`),
      () => {
        streamFileToDocker(dumpPath, [
          ...dockerContextArgs(),
          'exec',
          '-i',
          container,
          'pg_restore',
          '--exit-on-error',
          '--no-owner',
          '--no-acl',
          '-U',
          user,
          '-d',
          target,
        ]);
        const tablesRaw = psqlContainer(
          container,
          user,
          target,
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        );
        return tablesRaw ? tablesRaw.split(/\r?\n/).filter(Boolean) : [];
      },
      () => psqlContainer(container, user, 'postgres', `DROP DATABASE IF EXISTS ${assertRestoreTarget(target)} WITH (FORCE)`),
    );
  };

  return {
    backupNocobaseDb: (nativeDir) => backupNative({ directory: nativeDir }),
    rehearseNocobaseDb: (dumpPath, nativeDir, { verifyAppHealth = false, ephemeralContainer = null } = {}) => {
      if (ephemeralContainer) {
        assertContainerName(ephemeralContainer, 'ephemeral postgres container');
        const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
        return runRestoreFixture(
          target,
          () => psqlContainer(ephemeralContainer, 'postgres', 'postgres', `CREATE DATABASE ${target}`),
          () => {
            streamFileToDocker(dumpPath, [
              ...dockerContextArgs(),
              'exec',
              '-i',
              ephemeralContainer,
              'pg_restore',
              '--exit-on-error',
              '--no-owner',
              '--no-acl',
              '-U',
              'postgres',
              '-d',
              target,
            ]);
            const rows = JSON.parse(psqlContainer(ephemeralContainer, 'postgres', target, inventorySql).split('\n').at(-1));
            const rowMap = new Map(rows.map((r) => [r.table, r]));
            for (const table of requiredNativeTables) {
              if (!rowMap.has(table)) {
                throw new Error(`Restored ephemeral nocobase-db missing required table: ${table}`);
              }
            }
            const manifestMeta = JSON.parse(readFileSync(`${dumpPath}.json`, 'utf8'));
            if (Array.isArray(manifestMeta.inventory)) {
              const expectedMap = new Map(manifestMeta.inventory.map((r) => [r.table, r]));
              if (rows.length !== manifestMeta.inventory.length) {
                throw new Error('Restored ephemeral nocobase-db table count differs from backup manifest');
              }
              for (const [tbl, exp] of expectedMap) {
                const actual = rowMap.get(tbl);
                if (!actual || actual.rows !== exp.rows || actual.fingerprint !== exp.fingerprint) {
                  throw new Error(`Restored ephemeral nocobase-db table ${tbl} differs from backup manifest`);
                }
              }
            }
            const migrationsCount = Number(
              psqlContainer(
                ephemeralContainer,
                'postgres',
                target,
                "SELECT count(*) FROM migrations WHERE name LIKE '%/@latticedx/%'",
              ),
            );
            const collectionsCount = Number(
              psqlContainer(ephemeralContainer, 'postgres', target, 'SELECT count(*) FROM collections'),
            );
            const attachmentRow = rowMap.get('lattice_native_request_attachments');
            const appHealthy =
              Boolean(verifyAppHealth) &&
              Number.isFinite(migrationsCount) &&
              migrationsCount > 0 &&
              Number.isFinite(collectionsCount) &&
              collectionsCount > 0;
            return {
              format: 'latticedx.native-restore-rehearsal',
              scope: 'nocobase-database-only',
              fixtureDatabase: target,
              metadataVerified: true,
              ephemeralContainerVerified: true,
              nativeAttachmentBytesVerified: Boolean(attachmentRow && attachmentRow.rows > 0),
              applicationHealthVerified: appHealthy,
              migrationsCount,
              collectionsCount,
              tables: rows.length,
            };
          },
          () =>
            psqlContainer(
              ephemeralContainer,
              'postgres',
              'postgres',
              `DROP DATABASE IF EXISTS ${assertRestoreTarget(target)} WITH (FORCE)`,
            ),
        );
      }
      return rehearseNative(dumpPath, { directory: nativeDir, verifyAppHealth });
    },
    dumpUploads: (destPath) =>
      streamDockerToFile(
        [
          ...dockerContextArgs(),
          'exec',
          nocobaseApp,
          'sh',
          '-c',
          'mkdir -p /app/nocobase/storage/uploads && tar -czf - -C /app/nocobase/storage uploads',
        ],
        destPath,
        { cwd: REPO_ROOT },
      ),
    dumpEngineObjects: (destPath) => {
      const parentDir = dirname(objectsRoot) === '.' ? '/var/lib/latticedx' : dirname(objectsRoot);
      const baseName = basename(objectsRoot) || 'objects';
      return streamDockerToFile(
        [
          ...dockerContextArgs(),
          'exec',
          apiContainer,
          'sh',
          '-c',
          `mkdir -p "${objectsRoot}" && tar -czf - -C "${parentDir}" "${baseName}"`,
        ],
        destPath,
        { cwd: REPO_ROOT },
      );
    },
    listTarVerboseEntries: (tarPath) => {
      return execFileSync('tar', ['-tvzf', tarPath], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
        .split(/\r?\n/)
        .filter(Boolean);
    },
    listTarEntries: (tarPath) => {
      return execFileSync('tar', ['-tzf', tarPath], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
        .split(/\r?\n/)
        .filter(Boolean);
    },
    extractTarToDir: (tarPath, targetDir) => {
      execFileSync('tar', ['-xzf', tarPath, '-C', targetDir], {
        timeout: 60000,
        windowsHide: true,
      });
    },
    dumpKeycloakDb: (destPath) =>
      streamDockerToFile(
        [
          ...dockerContextArgs(),
          'exec',
          keycloakDb,
          'pg_dump',
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '-U',
          keycloakUser,
          '-d',
          keycloakDbName,
        ],
        destPath,
        { cwd: REPO_ROOT },
      ),
    dumpLatticeDb: (destPath) =>
      streamDockerToFile(
        [
          ...dockerContextArgs(),
          'exec',
          latticeDb,
          'pg_dump',
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '-U',
          latticeUser,
          '-d',
          latticeDbName,
        ],
        destPath,
        { cwd: REPO_ROOT },
      ),
    restoreKeycloakSnapshot: (dumpPath, target, { ephemeralContainer = null } = {}) => {
      const pgContainer = ephemeralContainer || keycloakDb;
      const pgUser = ephemeralContainer ? 'postgres' : keycloakUser;
      return restorePgStream(pgContainer, pgUser, dumpPath, target);
    },
    restoreLatticeSnapshot: (dumpPath, target, { ephemeralContainer = null } = {}) => {
      const pgContainer = ephemeralContainer || latticeDb;
      const pgUser = ephemeralContainer ? 'postgres' : latticeUser;
      const tables = restorePgStream(pgContainer, pgUser, dumpPath, target);
      for (const req of ['records', 'foundation_tasks', 'enterprise_entities', 'workflow_runs']) {
        if (!tables.includes(req)) {
          throw new Error(`Restored lattice-db missing expected table: ${req}`);
        }
      }
      return tables;
    },
    readKeycloakRealmFile: () => readFileSync(DEFAULT_REALM_PATH, 'utf8'),
    dumpOrionMongo: (destPath) =>
      streamDockerToFile(
        [...dockerContextArgs(), 'exec', orionMongo, 'mongodump', ...mongoAuthArgs, '--archive', '--gzip', '--quiet'],
        destPath,
        { cwd: REPO_ROOT },
      ),
    dryRunOrionRestore: (archivePath) => {
      streamFileToDocker(archivePath, [
        ...dockerContextArgs(),
        'exec',
        '-i',
        orionMongo,
        'mongorestore',
        ...mongoAuthArgs,
        '--archive',
        '--gzip',
        '--dryRun',
        '--quiet',
      ]);
      return { dryRunVerified: true };
    },
    exportN8nWorkflows: () =>
      extractJsonArray(
        dockerExecNoStdin(n8nContainer, [
          'sh',
          '-c',
          'rm -f /tmp/ldx_wf_export.json && (n8n export:workflow --all --output=/tmp/ldx_wf_export.json >/dev/null 2>&1 || true) && ([ -s /tmp/ldx_wf_export.json ] && cat /tmp/ldx_wf_export.json || echo "[]") && rm -f /tmp/ldx_wf_export.json',
        ]).toString('utf8'),
      ),
    exportN8nCredentials: () =>
      extractJsonArray(
        dockerExecNoStdin(n8nContainer, [
          'sh',
          '-c',
          'rm -f /tmp/ldx_cred_export.json && (n8n export:credentials --all --output=/tmp/ldx_cred_export.json >/dev/null 2>&1 || true) && ([ -s /tmp/ldx_cred_export.json ] && cat /tmp/ldx_cred_export.json || echo "[]") && rm -f /tmp/ldx_cred_export.json',
        ]).toString('utf8'),
      ),
    withEphemeralPostgres: (fn) => {
      const container = `ldx-dr-ephemeral-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const image = process.env.EPHEMERAL_PG_IMAGE?.trim() || DEFAULT_EPHEMERAL_PG_IMAGE;
      execFileSync(
        'docker',
        [
          ...dockerContextArgs(),
          'run',
          '--rm',
          '-d',
          '--name',
          container,
          '-e',
          'POSTGRES_USER=postgres',
          '-e',
          'POSTGRES_PASSWORD=ephemeral-dr-check',
          image,
        ],
        { cwd: REPO_ROOT, timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            execFileSync('docker', [...dockerContextArgs(), 'exec', container, 'pg_isready', '-U', 'postgres'], {
              cwd: REPO_ROOT,
              timeout: 5000,
              windowsHide: true,
              stdio: ['ignore', 'ignore', 'ignore'],
            });
            ready = true;
            break;
          } catch {
            syncSleepMs(300);
          }
        }
        if (!ready) throw new Error('Ephemeral Postgres container failed readiness timeout');
        psqlContainer(
          container,
          'postgres',
          'postgres',
          "DO $$ DECLARE r text; BEGIN FOR r IN SELECT unnest(ARRAY['nocobase','lattice','lattice_app','keycloak_app']) LOOP BEGIN EXECUTE format('CREATE ROLE %I LOGIN', r); EXCEPTION WHEN duplicate_object THEN NULL; END; END LOOP; END $$;",
        );
        return fn({ container, image });
      } finally {
        try {
          execFileSync('docker', [...dockerContextArgs(), 'rm', '-f', container], {
            cwd: REPO_ROOT,
            timeout: 30000,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch {
          // Best-effort forced cleanup.
        }
      }
    },
    verifyRestoredApplicationHealth: ({ components }) => {
      const nb = components['nocobase-db'];
      return {
        ok: Boolean(nb?.metadataVerified && nb?.applicationHealthVerified !== false),
        migrationsCount: nb?.migrationsCount ?? 0,
      };
    },
    checkWalArchiveReadiness: ({ walArchiveDir = process.env.PITR_WAL_DIR || '/var/lib/postgresql/wal-archive' } = {}) => {
      const postgresStatus = inspectPgWalReadiness(keycloakDb, keycloakUser, 'postgres', walArchiveDir);
      const nocobaseDbUser = process.env.NOCOBASE_DB_USER?.trim() || 'nocobase';
      const nocobaseStatus = inspectPgWalReadiness(nocobaseDb, nocobaseDbUser, 'nocobase', walArchiveDir);
      const targets = { postgres: postgresStatus, 'nocobase-db': nocobaseStatus };
      const ready = Object.values(targets).every(
        (t) =>
          t.archiveMode === 'on' &&
          typeof t.archiveCommand === 'string' &&
          t.archiveCommand.trim() !== '' &&
          t.archiveCommand.trim() !== '/bin/true' &&
          t.walDirReady &&
          t.archiveScriptReady,
      );
      return {
        ready,
        walArchiveDir,
        targets,
      };
    },
    applyRestoreComponent: (component, { bundleDir, dryRun }) => {
      if (dryRun) return { restored: false, dryRun: true };
      if (component === 'nocobase-db') {
        const meta = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')).components['nocobase-db'];
        streamFileToDocker(join(bundleDir, meta.file), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          nocobaseDb,
          'pg_restore',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          '-U',
          'nocobase',
          '-d',
          'nocobase',
        ]);
        return { restored: true };
      }
      if (component === 'keycloak') {
        streamFileToDocker(join(bundleDir, 'keycloak.dump'), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          keycloakDb,
          'pg_restore',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          '-U',
          keycloakUser,
          '-d',
          keycloakDbName,
        ]);
        return { restored: true };
      }
      if (component === 'lattice-db') {
        streamFileToDocker(join(bundleDir, 'lattice.dump'), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          latticeDb,
          'pg_restore',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          '-U',
          latticeUser,
          '-d',
          latticeDbName,
        ]);
        return { restored: true };
      }
      if (component === 'uploads') {
        streamFileToDocker(join(bundleDir, 'uploads.tar.gz'), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          nocobaseApp,
          'tar',
          '-xzf',
          '-',
          '-C',
          '/app/nocobase/storage',
        ]);
        return { restored: true };
      }
      if (component === 'engine-objects') {
        const parentDir = dirname(objectsRoot) === '.' ? '/var/lib/latticedx' : dirname(objectsRoot);
        streamFileToDocker(join(bundleDir, 'engine-objects.tar.gz'), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          apiContainer,
          'tar',
          '-xzf',
          '-',
          '-C',
          parentDir,
        ]);
        return { restored: true };
      }
      if (component === 'orion-mongo') {
        streamFileToDocker(join(bundleDir, 'orion-mongo.archive.gz'), [
          ...dockerContextArgs(),
          'exec',
          '-i',
          orionMongo,
          'mongorestore',
          ...mongoAuthArgs,
          '--archive',
          '--gzip',
          '--drop',
          '--quiet',
        ]);
        return { restored: true };
      }
      if (component === 'n8n') {
        for (const [flag, file] of [
          ['import:credentials', 'n8n-credentials.json'],
          ['import:workflow', 'n8n-workflows.json'],
        ]) {
          const tmpFile = `/tmp/ldx_restore_${randomUUID()}.json`;
          try {
            dockerExec(
              n8nContainer,
              [
                'node',
                '-e',
                "require('node:fs').writeFileSync(process.argv[1],require('node:fs').readFileSync(0),{mode:0o600})",
                tmpFile,
              ],
              readFileSync(join(bundleDir, file)),
            );
            dockerExecNoStdin(n8nContainer, ['n8n', flag, '--input', tmpFile]);
          } finally {
            dockerExecNoStdin(n8nContainer, ['rm', '-f', tmpFile]);
          }
        }
        return { restored: true };
      }
      throw new Error(`Unsupported restore component: ${component}`);
    },
  };
}

function assertGzipFileHead(filePath, label) {
  const head = readFileHead(filePath, 2);
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
    throw new Error(`${label} archive has invalid gzip magic bytes`);
  }
}

function assertPgDumpFileHead(filePath, label) {
  const head = readFileHead(filePath, 5);
  if (head.subarray(0, 5).toString() !== 'PGDMP') {
    throw new Error(`${label} PostgreSQL dump has invalid PGDMP header`);
  }
}

function writePrivateFile(path, data) {
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
}

function produceArtifactOnDisk(destPath, runnerFn) {
  const result = runnerFn(destPath);
  if (Buffer.isBuffer(result)) {
    writePrivateFile(destPath, result);
    return sha256File(destPath);
  }
  return sha256File(destPath);
}

function verifyDiskArtifact(bundleDir, meta, label) {
  const maxBytes = resolveMaxStreamingBackupBytes();
  const full = join(bundleDir, meta.file);
  const st = lstatSync(full);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== meta.bytes || st.size > maxBytes) {
    throw new Error(`${label} artifact size/file check failed`);
  }
  if (normalizePath(realpathSync(full)) !== normalizePath(resolve(full))) {
    throw new Error(`${label} symlink artifact forbidden`);
  }
  const { sha256 } = sha256File(full, { maxBytes });
  if (!SHA256_RE.test(meta.sha256) || sha256 !== meta.sha256) {
    throw new Error(`${label} checksum mismatch`);
  }
  return { full, bytes: meta.bytes, sha256 };
}

function verifySmallJsonArtifact(bundleDir, file, expectedSha, expectedBytes, label) {
  const meta = verifyDiskArtifact(bundleDir, { file, sha256: expectedSha, bytes: expectedBytes }, label);
  if (meta.bytes > 64 * 1024 * 1024) throw new Error(`${label} JSON exceeds safety cap`);
  return readFileSync(meta.full, 'utf8');
}

function inspectArchiveEntries(tarPath, runners) {
  if (typeof runners.listTarVerboseEntries === 'function') {
    return validateTarVerboseEntries(runners.listTarVerboseEntries(tarPath));
  }
  return validateTarEntries(runners.listTarEntries(tarPath));
}

function verifyAllBundleArtifacts(absBundle, manifest, targetComponents) {
  const verified = {};
  for (const name of targetComponents) {
    const meta = manifest.components[name];
    verified[name] = verifyDiskArtifact(absBundle, meta, name);
    if (name === 'keycloak') {
      verifySmallJsonArtifact(absBundle, meta.realmFile, meta.realmSha256, meta.realmBytes, 'keycloak-realm');
    } else if (name === 'n8n' && meta.credentialsFile) {
      verifySmallJsonArtifact(
        absBundle,
        meta.credentialsFile,
        meta.credentialsSha256,
        meta.credentialsBytes,
        'n8n-credentials',
      );
    }
  }
  return verified;
}

export function backupStack({
  components = STACK_COMPONENTS,
  runners = createDefaultRunners(),
  directory = DEFAULT_STACK_ROOT,
  env = process.env,
} = {}) {
  const requested = [...new Set(components)];
  if (requested.length === 0 || requested.some((c) => !STACK_COMPONENTS.includes(c))) {
    throw new Error('Invalid component selection for stack backup');
  }
  mkdirSync(directory, { recursive: true });
  const absRoot = assertSafeDir(directory);
  const id = randomUUID().replaceAll('-', '');
  if (!HEX32_RE.test(id)) throw new Error('Invalid bundle id');
  const bundleDir = join(absRoot, `stack-${id}`);
  mkdirSync(bundleDir, { mode: 0o700 });

  const componentMeta = {};
  for (const name of requested) {
    if (name === 'nocobase-db') {
      const nativeDir = join(bundleDir, 'nocobase');
      const res = runners.backupNocobaseDb(nativeDir);
      const dumpName = basename(res.path);
      const { bytes } = sha256File(res.path);
      componentMeta['nocobase-db'] = {
        file: `nocobase/${dumpName}`,
        sha256: res.sha256,
        bytes,
        tables: res.tables,
      };
    } else if (name === 'uploads' || name === 'engine-objects') {
      const fileName = name === 'uploads' ? 'uploads.tar.gz' : 'engine-objects.tar.gz';
      const label = name === 'uploads' ? 'Uploads' : 'Engine Objects';
      const runner = name === 'uploads' ? runners.dumpUploads : runners.dumpEngineObjects;
      const destPath = join(bundleDir, fileName);
      const { sha256, bytes } = produceArtifactOnDisk(destPath, runner);
      assertGzipFileHead(destPath, label);
      const entries = inspectArchiveEntries(destPath, runners);
      componentMeta[name] = { file: fileName, sha256, bytes, entryCount: entries.length };
    } else if (name === 'keycloak') {
      const destPath = join(bundleDir, 'keycloak.dump');
      const { sha256, bytes } = produceArtifactOnDisk(destPath, runners.dumpKeycloakDb);
      assertPgDumpFileHead(destPath, 'Keycloak');
      const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
      const tables = runners.restoreKeycloakSnapshot(destPath, target);
      const realmText = runners.readKeycloakRealmFile();
      JSON.parse(realmText);
      const realmBytes = Buffer.from(realmText, 'utf8');
      writePrivateFile(join(bundleDir, 'keycloak-realm.json'), realmBytes);
      componentMeta.keycloak = {
        file: 'keycloak.dump',
        sha256,
        bytes,
        tablesCount: Array.isArray(tables) ? tables.length : 0,
        realmFile: 'keycloak-realm.json',
        realmSha256: sha256Hex(realmBytes),
        realmBytes: realmBytes.length,
      };
    } else if (name === 'lattice-db') {
      const destPath = join(bundleDir, 'lattice.dump');
      const { sha256, bytes } = produceArtifactOnDisk(destPath, runners.dumpLatticeDb);
      assertPgDumpFileHead(destPath, 'Lattice API');
      const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
      const tables = runners.restoreLatticeSnapshot(destPath, target);
      componentMeta['lattice-db'] = {
        file: 'lattice.dump',
        sha256,
        bytes,
        tablesCount: Array.isArray(tables) ? tables.length : 0,
      };
    } else if (name === 'orion-mongo') {
      const destPath = join(bundleDir, 'orion-mongo.archive.gz');
      const { sha256, bytes } = produceArtifactOnDisk(destPath, runners.dumpOrionMongo);
      assertGzipFileHead(destPath, 'Orion MongoDB');
      componentMeta['orion-mongo'] = { file: 'orion-mongo.archive.gz', sha256, bytes };
    } else if (name === 'n8n') {
      const rawWf = extractJsonArray(runners.exportN8nWorkflows());
      const parsedWf = JSON.parse(rawWf);
      if (!Array.isArray(parsedWf)) throw new Error('n8n workflow export must be a JSON array');
      const sanitizedWf = parsedWf.map((wf) => ({
        id: wf.id,
        name: wf.name,
        active: Boolean(wf.active),
        nodes: Array.isArray(wf.nodes) ? wf.nodes : [],
        connections: wf.connections && typeof wf.connections === 'object' ? wf.connections : {},
        settings: wf.settings && typeof wf.settings === 'object' ? wf.settings : {},
      }));
      const wfBytes = Buffer.from(JSON.stringify(sanitizedWf, null, 2) + '\n', 'utf8');
      writePrivateFile(join(bundleDir, 'n8n-workflows.json'), wfBytes);

      const rawCreds =
        typeof runners.exportN8nCredentials === 'function' ? extractJsonArray(runners.exportN8nCredentials()) : '[]';
      const parsedCreds = JSON.parse(rawCreds);
      if (!Array.isArray(parsedCreds)) throw new Error('n8n credentials export must be a JSON array');
      const credBytes = Buffer.from(JSON.stringify(parsedCreds, null, 2) + '\n', 'utf8');
      writePrivateFile(join(bundleDir, 'n8n-credentials.json'), credBytes);

      componentMeta.n8n = {
        file: 'n8n-workflows.json',
        sha256: sha256Hex(wfBytes),
        bytes: wfBytes.length,
        workflowCount: sanitizedWf.length,
        credentialsFile: 'n8n-credentials.json',
        credentialsSha256: sha256Hex(credBytes),
        credentialsBytes: credBytes.length,
        credentialsCount: parsedCreds.length,
      };
    }
  }

  const skippedComponents = STACK_COMPONENTS.filter((c) => !requested.includes(c));
  const manifest = {
    format: STACK_BUNDLE_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    componentsRequested: requested,
    skippedComponents,
    envPresence: collectEnvPresence(env),
    components: componentMeta,
  };
  const manifestPath = join(bundleDir, 'manifest.json');
  writePrivateFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    format: manifest.format,
    bundleDir,
    manifestPath,
    componentsSucceeded: requested,
    skippedComponents,
    envPresence: manifest.envPresence,
  };
}

export function rehearseStack(
  bundleDir,
  {
    components = null,
    runners = createDefaultRunners(),
    directory = DEFAULT_STACK_ROOT,
    ephemeral = false,
  } = {},
) {
  const absBundle = assertStackBundleDir(bundleDir, directory);
  const manifestPath = join(absBundle, 'manifest.json');
  const mStat = lstatSync(manifestPath);
  if (!mStat.isFile() || mStat.isSymbolicLink() || mStat.size > 8 * 1024 * 1024) {
    throw new Error('Invalid stack backup manifest file');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== STACK_BUNDLE_FORMAT || manifest.version !== 1 || !manifest.components) {
    throw new Error('Unsupported stack backup manifest');
  }

  const targetComponents = components ? [...new Set(components)] : [...manifest.componentsRequested];
  for (const name of targetComponents) {
    if (!manifest.components[name]) {
      throw new Error(`Requested component "${name}" is not present in bundle`);
    }
  }

  // Fail closed on ALL artifact checksums before touching any restore target or ephemeral container.
  const verified = verifyAllBundleArtifacts(absBundle, manifest, targetComponents);

  const runInsideContext = (ephemeralCtx) => {
    const ephemeralContainer = ephemeralCtx?.container ?? null;
    const results = {};
    for (const name of targetComponents) {
      const meta = manifest.components[name];
      const artifactPath = verified[name].full;

      if (name === 'nocobase-db') {
        results['nocobase-db'] = runners.rehearseNocobaseDb(artifactPath, join(absBundle, 'nocobase'), {
          verifyAppHealth: Boolean(ephemeralContainer),
          ephemeralContainer,
        });
      } else if (name === 'uploads' || name === 'engine-objects') {
        assertGzipFileHead(artifactPath, name);
        const entries = inspectArchiveEntries(artifactPath, runners);
        const tempDir = mkdtempSync(join(tmpdir(), `ldx-${name}-rehearse-`));
        try {
          runners.extractTarToDir(artifactPath, tempDir);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
        results[name] = { verified: true, entryCount: entries.length };
      } else if (name === 'keycloak') {
        assertPgDumpFileHead(artifactPath, 'Keycloak');
        const realmJson = JSON.parse(readFileSync(join(absBundle, meta.realmFile), 'utf8'));
        const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
        const tables = runners.restoreKeycloakSnapshot(artifactPath, target, { ephemeralContainer });
        results.keycloak = {
          verified: true,
          fixtureDatabase: target,
          tablesCount: Array.isArray(tables) ? tables.length : 0,
          realm: realmJson.realm || 'unknown',
          ephemeral: Boolean(ephemeralContainer),
        };
      } else if (name === 'lattice-db') {
        assertPgDumpFileHead(artifactPath, 'Lattice API');
        const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
        const tables = runners.restoreLatticeSnapshot(artifactPath, target, { ephemeralContainer });
        results['lattice-db'] = {
          verified: true,
          fixtureDatabase: target,
          tablesCount: Array.isArray(tables) ? tables.length : 0,
          ephemeral: Boolean(ephemeralContainer),
        };
      } else if (name === 'orion-mongo') {
        assertGzipFileHead(artifactPath, 'Orion MongoDB');
        const res = runners.dryRunOrionRestore(artifactPath);
        results['orion-mongo'] = { verified: Boolean(res?.dryRunVerified), bytes: meta.bytes };
      } else if (name === 'n8n') {
        const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
        if (!Array.isArray(parsed) || parsed.length !== meta.workflowCount) {
          throw new Error('n8n workflow archive count mismatch');
        }
        let credentialsCount = 0;
        if (meta.credentialsFile) {
          const parsedCreds = JSON.parse(readFileSync(join(absBundle, meta.credentialsFile), 'utf8'));
          if (!Array.isArray(parsedCreds) || parsedCreds.length !== meta.credentialsCount) {
            throw new Error('n8n credentials archive count mismatch');
          }
          credentialsCount = parsedCreds.length;
        }
        results.n8n = { verified: true, workflowCount: parsed.length, credentialsCount };
      }
    }
    return { ephemeralContainer, results };
  };

  const needsPgEphemeral =
    Boolean(ephemeral) && targetComponents.some((c) => ['nocobase-db', 'keycloak', 'lattice-db'].includes(c));
  const { ephemeralContainer, results } = needsPgEphemeral
    ? runners.withEphemeralPostgres((ctx) => runInsideContext(ctx))
    : runInsideContext(null);

  const skippedComponents = STACK_COMPONENTS.filter((c) => !targetComponents.includes(c));
  const fullStackVerified = skippedComponents.length === 0 && targetComponents.length === STACK_COMPONENTS.length;
  const ephemeralContainerVerified = Boolean(ephemeralContainer);
  const objectsVerified = Boolean(
    (!targetComponents.includes('uploads') || results.uploads?.verified) &&
      (!targetComponents.includes('engine-objects') || results['engine-objects']?.verified) &&
      (targetComponents.includes('uploads') || targetComponents.includes('engine-objects')),
  );
  const nativeAttachmentBytesVerified = Boolean(
    results['nocobase-db']?.nativeAttachmentBytesVerified ||
      (results.uploads?.verified && results.uploads?.entryCount > 0),
  );
  const appCheck =
    typeof runners.verifyRestoredApplicationHealth === 'function'
      ? runners.verifyRestoredApplicationHealth({ components: results, ephemeralContainer })
      : { ok: Boolean(results['nocobase-db']?.applicationHealthVerified) };
  const applicationHealthVerified = Boolean(
    ephemeralContainerVerified && results['nocobase-db']?.metadataVerified && appCheck?.ok,
  );
  const fullRecoverability = Boolean(
    fullStackVerified && ephemeralContainerVerified && objectsVerified && applicationHealthVerified,
  );
  const walArchive =
    typeof runners.checkWalArchiveReadiness === 'function'
      ? verifyWalArchiveReadiness({ runners })
      : null;

  const report = {
    format: STACK_REHEARSAL_FORMAT,
    version: 1,
    completedAt: new Date().toISOString(),
    bundleDir: absBundle,
    fullStackVerified,
    ephemeralContainerVerified,
    nativeAttachmentBytesVerified,
    objectsVerified,
    applicationHealthVerified,
    fullRecoverability,
    ...(walArchive ? { walArchiveReady: walArchive.ready, walArchive } : {}),
    skippedComponents,
    components: results,
  };
  const reportPath = join(absBundle, `stack-rehearsal-${randomUUID().replaceAll('-', '')}.json`);
  writePrivateFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { reportPath, ...report };
}

export function verifyWalArchiveReadiness({
  runners = createDefaultRunners(),
  walArchiveDir = process.env.PITR_WAL_DIR || '/var/lib/postgresql/wal-archive',
  strict = false,
} = {}) {
  if (typeof runners?.checkWalArchiveReadiness !== 'function') {
    throw new Error('WAL archive readiness check runner is unavailable');
  }
  const result = runners.checkWalArchiveReadiness({ walArchiveDir });
  const targets = result?.targets && typeof result.targets === 'object' ? result.targets : {};
  const entries = Object.entries(targets);
  const allTargetsReady =
    entries.length > 0 &&
    entries.every(
      ([, target]) =>
        target?.archiveMode === 'on' &&
        typeof target?.archiveCommand === 'string' &&
        target.archiveCommand.trim() !== '' &&
        target.archiveCommand.trim() !== '/bin/true' &&
        Boolean(target?.walDirReady) &&
        Boolean(target?.archiveScriptReady),
    );
  const ready = Boolean(result?.ready && allTargetsReady);
  if (strict && !ready) {
    throw new Error('PostgreSQL PITR WAL archive readiness check failed');
  }
  return {
    ready,
    walArchiveDir: result?.walArchiveDir || walArchiveDir,
    targets,
  };
}

export function restoreStack(
  bundleDir,
  {
    confirmRestore,
    dryRun = false,
    components = null,
    runners = createDefaultRunners(),
    directory = DEFAULT_STACK_ROOT,
  } = {},
) {
  const absBundle = assertStackBundleDir(bundleDir, directory);
  const bundleId = basename(absBundle);
  if (typeof confirmRestore !== 'string' || confirmRestore !== bundleId) {
    throw new Error(`Refusing restore without exact --confirm-restore=${bundleId}`);
  }
  const manifestPath = join(absBundle, 'manifest.json');
  const mStat = lstatSync(manifestPath);
  if (!mStat.isFile() || mStat.isSymbolicLink() || mStat.size > 8 * 1024 * 1024) {
    throw new Error('Invalid stack backup manifest file');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== STACK_BUNDLE_FORMAT || manifest.version !== 1 || !manifest.components) {
    throw new Error('Unsupported stack backup manifest');
  }
  const targetComponents = components ? [...new Set(components)] : [...manifest.componentsRequested];
  for (const name of targetComponents) {
    if (!manifest.components[name]) {
      throw new Error(`Requested component "${name}" is not present in bundle`);
    }
  }

  // Fail closed before mutating any target service
  const verified = verifyAllBundleArtifacts(absBundle, manifest, targetComponents);
  for (const name of targetComponents) {
    const filePath = verified[name].full;
    if (name === 'nocobase-db' || name === 'keycloak' || name === 'lattice-db') {
      assertPgDumpFileHead(filePath, name);
    } else if (name === 'uploads' || name === 'engine-objects') {
      assertGzipFileHead(filePath, name);
      inspectArchiveEntries(filePath, runners);
    } else if (name === 'orion-mongo') {
      assertGzipFileHead(filePath, name);
    }
  }

  const results = {};
  for (const name of targetComponents) {
    results[name] = runners.applyRestoreComponent(name, { bundleDir: absBundle, dryRun });
  }

  return {
    format: STACK_RESTORE_FORMAT,
    version: 1,
    bundleDir: absBundle,
    dryRun: Boolean(dryRun),
    componentsRestored: targetComponents,
    results,
    completedAt: new Date().toISOString(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseStackRecoveryArgs(process.argv.slice(2));
    if (parsed.mode === 'backup') {
      console.log(JSON.stringify(backupStack({ components: parsed.components }), null, 2));
    } else if (parsed.mode === 'rehearse') {
      console.log(
        JSON.stringify(
          rehearseStack(parsed.bundlePath, {
            components: parsed.components,
            ephemeral: parsed.ephemeral,
          }),
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          restoreStack(parsed.bundlePath, {
            components: parsed.components,
            confirmRestore: parsed.confirmRestore,
            dryRun: parsed.dryRun,
          }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
