/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { resolve, relative, basename, isAbsolute, dirname } from 'node:path';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';

export const maxBackupBytes = 256 * 1024 * 1024;
export const maxStreamingBackupBytes = 10 * 1024 * 1024 * 1024;

export function resolveMaxStreamingBackupBytes(env = process.env) {
  const raw = env?.LATTICE_MAX_BACKUP_BYTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return maxStreamingBackupBytes;
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new Error('Invalid LATTICE_MAX_BACKUP_BYTES');
  }
  return num;
}

export function assertRestoreTarget(name) {
  if (typeof name !== 'string' || !/^dx_restore_[a-f0-9]{32}$/.test(name)) {
    throw new Error('Only a generated recovery fixture database is allowed.');
  }
  return name;
}

export function assertBackupPath(file, root) {
  const path = resolve(file);
  const within = relative(resolve(root), path);
  if (
    within.startsWith('..') ||
    isAbsolute(within) ||
    dirname(path) !== resolve(root) ||
    !/^core-[a-f0-9]{32}\.dump$/.test(basename(path))
  ) {
    throw new Error('Backup must be an approved artifact inside output/backups.');
  }
  return path;
}

export function assertRegularBackup(file, root) {
  const path = assertBackupPath(file, root);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Backup must be a regular file.');
  }
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    normalize(realpathSync(root)) !== normalize(resolve(root)) ||
    normalize(realpathSync(path)) !== normalize(path)
  ) {
    throw new Error('Backup path links are not allowed.');
  }
  if (stat.size > maxBackupBytes) {
    throw new Error('Backup exceeds 256 MiB.');
  }
  return path;
}

export function verifyBackup(bytes, manifest) {
  if (
    manifest?.format !== 'latticedx.pg-backup' ||
    manifest.version !== 1 ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error('Unsupported backup manifest.');
  }
  if (
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > maxBackupBytes ||
    manifest.bytes !== bytes.length
  ) {
    throw new Error('Backup byte length invalid.');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('Backup checksum mismatch.');
  }
}

export function runRestoreFixture(database, create, work, drop) {
  assertRestoreTarget(database);
  let failure;
  try {
    create();
    return work();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      drop();
    } catch (cleanup) {
      if (failure) {
        throw new AggregateError([failure, cleanup], 'Restore failed and fixture cleanup failed.');
      }
      throw cleanup;
    }
  }
}

export function readFileHead(filePath, length = 16) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function sha256File(filePath, { maxBytes = resolveMaxStreamingBackupBytes() } = {}) {
  const st = lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) {
    throw new Error('Streaming artifact failed file or size check');
  }
  const hash = createHash('sha256');
  const chunkSize = 1024 * 1024;
  const buf = Buffer.allocUnsafe(chunkSize);
  let total = 0;
  const fd = openSync(filePath, 'r');
  try {
    let n;
    while ((n = readSync(fd, buf, 0, chunkSize, null)) > 0) {
      total += n;
      if (total > maxBytes) {
        throw new Error('Streaming artifact exceeded byte limit');
      }
      hash.update(n === chunkSize ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes: total };
}

export function streamDockerToFile(
  dockerCliArgs,
  outputPath,
  { cwd = process.cwd(), timeoutMs = 300000, maxBytes = resolveMaxStreamingBackupBytes() } = {},
) {
  const fd = openSync(outputPath, 'wx', 0o600);
  let res;
  try {
    res = spawnSync('docker', dockerCliArgs, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', fd, 'pipe'],
    });
  } finally {
    closeSync(fd);
  }
  if (res.error || res.status !== 0 || res.signal) {
    rmSync(outputPath, { force: true });
    throw new Error('Docker streaming export failed; output withheld');
  }
  const st = statSync(outputPath);
  if (st.size < 1 || st.size > maxBytes) {
    rmSync(outputPath, { force: true });
    throw new Error('Exported artifact is empty or exceeds streaming byte limit');
  }
  return sha256File(outputPath, { maxBytes });
}

export function streamFileToDocker(
  inputPath,
  dockerCliArgs,
  { cwd = process.cwd(), timeoutMs = 300000 } = {},
) {
  const st = lstatSync(inputPath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error('Refusing to stream non-regular file or symlink into Docker');
  }
  const fd = openSync(inputPath, 'r');
  let res;
  try {
    res = spawnSync('docker', dockerCliArgs, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      stdio: [fd, 'pipe', 'pipe'],
    });
  } finally {
    closeSync(fd);
  }
  if (res.error || res.status !== 0 || res.signal) {
    throw new Error('Docker streaming import failed; output withheld');
  }
  return Buffer.from(res.stdout || '', 'utf8');
}
