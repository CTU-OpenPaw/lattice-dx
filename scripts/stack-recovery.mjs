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
  runRestoreFixture,
} from './lib/backup-policy.mjs';
import { backupNative, rehearseNative } from './native-database-recovery.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STACK_ROOT = join(REPO_ROOT, 'output/backups/stack');
const DEFAULT_REALM_PATH = join(REPO_ROOT, 'infra/config/keycloak/lattice-realm.json');
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const HEX32_RE = /^[a-f0-9]{32}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export const STACK_COMPONENTS = ['nocobase-db', 'uploads', 'keycloak', 'orion-mongo', 'n8n'];
export const STACK_BUNDLE_FORMAT = 'latticedx.stack-backup';
export const STACK_REHEARSAL_FORMAT = 'latticedx.stack-restore-rehearsal';
export const DEFAULT_ENV_PRESENCE_KEYS = [
  'APP_KEY',
  'ENCRYPTION_FIELD_KEY',
  'DB_PASSWORD',
  'N8N_ENCRYPTION_KEY',
  'AGENT_API_KEY',
];

const normalizePath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

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
    return execFileSync('docker', ['--context', 'desktop-linux', 'exec', '-i', container, ...args], {
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

export function parseStackRecoveryArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('Usage: node scripts/stack-recovery.mjs backup | rehearse <bundleDir> [--components=nocobase-db,uploads,keycloak,orion-mongo,n8n]');
  }
  const [mode, ...rest] = argv;
  if (!['backup', 'rehearse'].includes(mode)) {
    throw new Error('Usage: node scripts/stack-recovery.mjs backup | rehearse <bundleDir> [--components=...]');
  }

  let bundlePath = null;
  let components = [...STACK_COMPONENTS];
  let sawComponents = false;

  for (const arg of rest) {
    if (arg.startsWith('--components=')) {
      if (sawComponents) throw new Error('Duplicate --components argument');
      sawComponents = true;
      const list = arg.slice('--components='.length).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new Error('At least one component must be specified');
      for (const item of list) {
        if (!STACK_COMPONENTS.includes(item)) throw new Error(`Unknown component: ${item}`);
      }
      components = [...new Set(list)];
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (mode === 'rehearse' && bundlePath === null) {
      bundlePath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (mode === 'rehearse' && !bundlePath) {
    throw new Error('Usage: node scripts/stack-recovery.mjs rehearse <bundleDir> [--components=...]');
  }
  return { mode, bundlePath, components };
}

export function assertStackBundleDir(bundleDir, root = DEFAULT_STACK_ROOT) {
  const absRoot = resolve(root);
  const absBundle = resolve(bundleDir);
  const rel = relative(absRoot, absBundle);
  if (rel.startsWith('..') || isAbsolute(rel) || dirname(absBundle) !== absRoot || !/^stack-[a-f0-9]{32}$/.test(basename(absBundle))) {
    throw new Error('Bundle directory must be an approved stack-<id> folder inside output/backups/stack');
  }
  const st = lstatSync(absBundle);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('Bundle path must be a real directory (links forbidden)');
  }
  if (normalizePath(realpathSync(absRoot)) !== normalizePath(absRoot) || normalizePath(realpathSync(absBundle)) !== normalizePath(absBundle)) {
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

export function collectEnvPresence(env = process.env, keys = DEFAULT_ENV_PRESENCE_KEYS) {
  const presence = {};
  for (const key of keys) {
    presence[key] = typeof env?.[key] === 'string' && env[key].trim().length > 0;
  }
  return presence;
}

export function createDefaultRunners() {
  const nocobaseApp = process.env.NATIVE_APP_CONTAINER ?? 'lattice-dx-nocobase-1';
  const keycloakDb = process.env.KEYCLOAK_DB_CONTAINER ?? 'lattice-dx-postgres-1';
  const keycloakUser = process.env.KEYCLOAK_DB_USER ?? 'lattice';
  const keycloakDbName = process.env.KEYCLOAK_DB_NAME ?? 'keycloak';
  const orionMongo = process.env.ORION_MONGO_CONTAINER ?? 'lattice-dx-orion-mongo-1';
  const n8nContainer = process.env.N8N_CONTAINER ?? 'lattice-dx-n8n-1';

  const psqlKeycloak = (database, statement) =>
    dockerExec(keycloakDb, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', keycloakUser, '-d', database, '-At', '-c', statement])
      .toString()
      .trim();

  return {
    backupNocobaseDb: (nativeDir) => backupNative({ directory: nativeDir }),
    rehearseNocobaseDb: (dumpPath, nativeDir) => rehearseNative(dumpPath, { directory: nativeDir }),
    dumpUploads: () =>
      dockerExec(nocobaseApp, ['sh', '-c', 'mkdir -p /app/nocobase/storage/uploads && tar -czf - -C /app/nocobase/storage uploads']),
    listTarEntries: (tarBytes) => {
      const tmp = mkdtempSync(join(tmpdir(), 'ldx-tar-list-'));
      try {
        const tgz = join(tmp, 'uploads.tar.gz');
        writeFileSync(tgz, tarBytes);
        return execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', timeout: 60000, windowsHide: true })
          .split(/\r?\n/)
          .filter(Boolean);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    extractTarToDir: (tarBytes, targetDir) => {
      const tmp = mkdtempSync(join(tmpdir(), 'ldx-tar-ext-'));
      try {
        const tgz = join(tmp, 'uploads.tar.gz');
        writeFileSync(tgz, tarBytes);
        execFileSync('tar', ['-xzf', tgz, '-C', targetDir], { timeout: 60000, windowsHide: true });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    dumpKeycloakDb: () =>
      dockerExec(keycloakDb, ['pg_dump', '--format=custom', '--no-owner', '--no-acl', '-U', keycloakUser, '-d', keycloakDbName]),
    restoreKeycloakSnapshot: (bytes, target) => {
      assertRestoreTarget(target);
      return runRestoreFixture(
        target,
        () => psqlKeycloak('postgres', `CREATE DATABASE ${target}`),
        () => {
          dockerExec(keycloakDb, ['pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-U', keycloakUser, '-d', target], bytes);
          const tablesRaw = psqlKeycloak(target, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
          return tablesRaw ? tablesRaw.split(/\r?\n/).filter(Boolean) : [];
        },
        () => psqlKeycloak('postgres', `DROP DATABASE IF EXISTS ${assertRestoreTarget(target)} WITH (FORCE)`),
      );
    },
    readKeycloakRealmFile: () => readFileSync(DEFAULT_REALM_PATH, 'utf8'),
    dumpOrionMongo: () => dockerExec(orionMongo, ['mongodump', '--archive', '--gzip', '--quiet']),
    dryRunOrionRestore: (bytes) => {
      dockerExec(orionMongo, ['mongorestore', '--archive', '--gzip', '--dryRun', '--quiet'], bytes);
      return { dryRunVerified: true };
    },
    exportN8nWorkflows: () =>
      dockerExec(n8nContainer, [
        'sh',
        '-c',
        'rm -f /tmp/ldx_wf_export.json && n8n export:workflow --all --output=/tmp/ldx_wf_export.json >/dev/null 2>&1 && (cat /tmp/ldx_wf_export.json || echo "[]") && rm -f /tmp/ldx_wf_export.json',
      ]).toString('utf8'),
  };
}

function assertGzipBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 18 || bytes.length > maxBackupBytes || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`${label} archive is invalid gzip or exceeds 256 MiB`);
  }
}

function writePrivateFile(path, data) {
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
}

function verifyFileArtifact(bundleDir, meta, label) {
  const full = join(bundleDir, meta.file);
  const st = lstatSync(full);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== meta.bytes || st.size > maxBackupBytes) {
    throw new Error(`${label} artifact size/file check failed`);
  }
  const bytes = readFileSync(full);
  if (!SHA256_RE.test(meta.sha256) || sha256Hex(bytes) !== meta.sha256) {
    throw new Error(`${label} checksum mismatch`);
  }
  return bytes;
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
      componentMeta['nocobase-db'] = {
        file: `nocobase/${dumpName}`,
        sha256: res.sha256,
        bytes: readFileSync(res.path).length,
        tables: res.tables,
      };
    } else if (name === 'uploads') {
      const bytes = runners.dumpUploads();
      assertGzipBytes(bytes, 'Uploads');
      const entries = validateTarEntries(runners.listTarEntries(bytes));
      writePrivateFile(join(bundleDir, 'uploads.tar.gz'), bytes);
      componentMeta.uploads = {
        file: 'uploads.tar.gz',
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        entryCount: entries.length,
      };
    } else if (name === 'keycloak') {
      const dumpBytes = runners.dumpKeycloakDb();
      if (!Buffer.isBuffer(dumpBytes) || dumpBytes.length > maxBackupBytes || dumpBytes.subarray(0, 5).toString() !== 'PGDMP') {
        throw new Error('Keycloak PostgreSQL dump is invalid or exceeds 256 MiB');
      }
      const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
      const tables = runners.restoreKeycloakSnapshot(dumpBytes, target);
      const realmText = runners.readKeycloakRealmFile();
      JSON.parse(realmText);
      const realmBytes = Buffer.from(realmText, 'utf8');
      writePrivateFile(join(bundleDir, 'keycloak.dump'), dumpBytes);
      writePrivateFile(join(bundleDir, 'keycloak-realm.json'), realmBytes);
      componentMeta.keycloak = {
        file: 'keycloak.dump',
        sha256: sha256Hex(dumpBytes),
        bytes: dumpBytes.length,
        tablesCount: Array.isArray(tables) ? tables.length : 0,
        realmFile: 'keycloak-realm.json',
        realmSha256: sha256Hex(realmBytes),
        realmBytes: realmBytes.length,
      };
    } else if (name === 'orion-mongo') {
      const bytes = runners.dumpOrionMongo();
      assertGzipBytes(bytes, 'Orion MongoDB');
      writePrivateFile(join(bundleDir, 'orion-mongo.archive.gz'), bytes);
      componentMeta['orion-mongo'] = {
        file: 'orion-mongo.archive.gz',
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
      };
    } else if (name === 'n8n') {
      const raw = String(runners.exportN8nWorkflows() || '[]').trim() || '[]';
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('n8n workflow export must be a JSON array');
      const sanitized = parsed.map((wf) => ({
        id: wf.id,
        name: wf.name,
        active: Boolean(wf.active),
        nodes: Array.isArray(wf.nodes) ? wf.nodes : [],
        connections: wf.connections && typeof wf.connections === 'object' ? wf.connections : {},
        settings: wf.settings && typeof wf.settings === 'object' ? wf.settings : {},
      }));
      const bytes = Buffer.from(JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
      writePrivateFile(join(bundleDir, 'n8n-workflows.json'), bytes);
      componentMeta.n8n = {
        file: 'n8n-workflows.json',
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        workflowCount: sanitized.length,
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

  // Fail closed on any artifact checksum tampering before touching any ephemeral restore database/dir.
  const verifiedBytes = {};
  for (const name of targetComponents) {
    const meta = manifest.components[name];
    verifiedBytes[name] = verifyFileArtifact(absBundle, meta, name);
    if (name === 'keycloak') {
      const realmMeta = { file: meta.realmFile, sha256: meta.realmSha256, bytes: meta.realmBytes };
      verifyFileArtifact(absBundle, realmMeta, 'keycloak-realm');
    }
  }

  const results = {};
  for (const name of targetComponents) {
    const meta = manifest.components[name];
    if (name === 'nocobase-db') {
      results['nocobase-db'] = runners.rehearseNocobaseDb(join(absBundle, meta.file), join(absBundle, 'nocobase'));
    } else if (name === 'uploads') {
      const bytes = verifiedBytes.uploads;
      assertGzipBytes(bytes, 'Uploads');
      const entries = validateTarEntries(runners.listTarEntries(bytes));
      const tempDir = mkdtempSync(join(tmpdir(), 'ldx-uploads-rehearse-'));
      try {
        runners.extractTarToDir(bytes, tempDir);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      results.uploads = { verified: true, entryCount: entries.length };
    } else if (name === 'keycloak') {
      const dumpBytes = verifiedBytes.keycloak;
      if (dumpBytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Invalid Keycloak dump header');
      const realmJson = JSON.parse(readFileSync(join(absBundle, meta.realmFile), 'utf8'));
      const target = assertRestoreTarget(`dx_restore_${randomUUID().replaceAll('-', '')}`);
      const tables = runners.restoreKeycloakSnapshot(dumpBytes, target);
      results.keycloak = {
        verified: true,
        fixtureDatabase: target,
        tablesCount: Array.isArray(tables) ? tables.length : 0,
        realm: realmJson.realm || 'unknown',
      };
    } else if (name === 'orion-mongo') {
      const bytes = verifiedBytes['orion-mongo'];
      assertGzipBytes(bytes, 'Orion MongoDB');
      const res = runners.dryRunOrionRestore(bytes);
      results['orion-mongo'] = { verified: Boolean(res?.dryRunVerified), bytes: bytes.length };
    } else if (name === 'n8n') {
      const parsed = JSON.parse(verifiedBytes.n8n.toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== meta.workflowCount) {
        throw new Error('n8n workflow archive count mismatch');
      }
      results.n8n = { verified: true, workflowCount: parsed.length };
    }
  }

  const skippedComponents = STACK_COMPONENTS.filter((c) => !targetComponents.includes(c));
  const fullStackVerified = skippedComponents.length === 0 && targetComponents.length === STACK_COMPONENTS.length;
  const report = {
    format: STACK_REHEARSAL_FORMAT,
    version: 1,
    completedAt: new Date().toISOString(),
    bundleDir: absBundle,
    fullStackVerified,
    skippedComponents,
    components: results,
  };
  const reportPath = join(absBundle, `stack-rehearsal-${randomUUID().replaceAll('-', '')}.json`);
  writePrivateFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { reportPath, ...report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseStackRecoveryArgs(process.argv.slice(2));
    if (parsed.mode === 'backup') {
      console.log(JSON.stringify(backupStack({ components: parsed.components }), null, 2));
    } else {
      console.log(JSON.stringify(rehearseStack(parsed.bundlePath, { components: parsed.components }), null, 2));
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
