// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['--context', 'desktop-linux', 'compose', '-f', 'infra/compose/nocobase.yml'];
const packages = [
  { directory: 'action-bridge', name: '@latticedx/plugin-action-bridge', build: 'build.mjs' },
  { directory: 'plugin-lattice-foundation', name: '@latticedx/plugin-lattice-foundation', build: 'scripts/build.mjs' },
  { directory: 'plugin-enterprise-auth', name: '@latticedx/plugin-enterprise-auth', build: 'build.mjs', restoreDependencies: true },
];

export function defaultRun(file, args, { timeout }) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: root, shell: false, windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) { child.kill(); reject(new Error('Command output exceeded limit')); }
      else chunks.push(chunk);
    });
    // Drain stderr without displaying potentially sensitive command output.
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('Workspace command failed to start')));
    child.on('close', (code, signal) => code === 0 && !signal ? accept(Buffer.concat(chunks)) : reject(new Error('Workspace command failed')));
  });
}

export function parsePluginList(stdout) {
  const match = String(stdout).match(/--- BEGIN_PLUGIN_LIST_JSON ---\s*([\s\S]*?)\s*--- END_PLUGIN_LIST_JSON ---/);
  if (!match) throw new Error('Plugin registry markers missing');
  try {
    const list = JSON.parse(match[1]);
    if (!Array.isArray(list)) throw new Error();
    return list;
  } catch { throw new Error('Plugin registry JSON invalid'); }
}

async function publicHealth() {
  try { return (await fetch('http://127.0.0.1:13000/api/app:getLang', { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok; }
  catch { return false; }
}

export async function installWorkspace({ run = defaultRun, backupDir = resolve(root, 'output/backups'), health = publicHealth } = {}) {
  const command = async (file, args, timeout) => {
    try { return await run(file, args, { timeout, shell: false }); }
    catch { throw new Error('Workspace command failed; command output withheld'); }
  };
  const docker = (args, timeout = 120000) => command('docker', [...compose, ...args], timeout);
  const exec = (args, timeout = 120000) => docker(['exec', '-T', 'nocobase', ...args], timeout);
  const local = [];
  for (const pkg of packages) {
    const source = `plugins/nocobase/${pkg.directory}`;
    const metadata = JSON.parse(await readFile(resolve(root, source, 'package.json'), 'utf8'));
    if (metadata.name !== pkg.name || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Unexpected source package metadata');
    local.push({ ...pkg, version: metadata.version });
  }
  const id = randomUUID();
  let dump;
  try { dump = Buffer.from(await docker(['exec', '-T', 'nocobase-db', 'pg_dump', '--format=custom', '-U', 'nocobase', '-d', 'nocobase'], 60000)); }
  catch { throw new Error('Database backup failed; runtime unchanged'); }
  if (dump.length <= 5 || dump.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Database backup is empty or invalid');
  await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `nocobase-before-workspace-${id}.dump`);
  await writeFile(backupPath, dump, { flag: 'wx', mode: 0o600 });
  await writeFile(backupPath + '.json', JSON.stringify({ size: dump.length, sha256: createHash('sha256').update(dump).digest('hex'), scope: 'NocoBase database only', restoreRehearsed: false, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  // These directories are live bind mounts, so build only after backup succeeds.
  for (const pkg of local) {
    if (pkg.restoreDependencies) {
      const npmCli = [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].find(existsSync);
      if (!npmCli) throw new Error('Node.js npm CLI is required to restore locked plugin dependencies; runtime unchanged.');
      await command(process.execPath, [npmCli, 'ci', '--prefix', `plugins/nocobase/${pkg.directory}`, '--ignore-scripts', '--no-audit', '--no-fund'], 120000);
    }
    await command(process.execPath, [`plugins/nocobase/${pkg.directory}/${pkg.build}`], 120000);
  }
  await docker(['up', '-d', '--no-deps', '--force-recreate', 'nocobase']);
  const waitHealthy = async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer;
      const ready = await Promise.race([health(), new Promise(r => { timer = setTimeout(() => r(false), Math.min(3000, remaining)); })]).finally(() => clearTimeout(timer));
      if (ready) return;
      await new Promise(r => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('NocoBase public health timed out');
  };
  await waitHealthy();
  const destination = `/tmp/latticedx-workspace-${id}`;
  await exec(['node', '-e', "require('node:fs').mkdirSync(process.argv[1])", destination], 30000);
  for (const pkg of local) {
    const mount = `/app/nocobase/node_modules/${pkg.name}`;
    await docker(['exec', '-T', '-w', mount, 'nocobase', 'npm', 'pack', '--offline', '--ignore-scripts', '--pack-destination', destination], 30000);
    const tarball = `${destination}/${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
    await exec(['yarn', 'nocobase', 'pm', 'add', tarball]);
    await exec(['yarn', 'nocobase', 'pm', 'enable', pkg.name]);
  }
  const registry = parsePluginList(await exec(['yarn', 'nocobase', 'pm', 'list'], 30000));
  for (const pkg of local) {
    const entries = registry.filter(row => row.packageName === pkg.name);
    if (entries.length !== 1 || entries[0].enabled !== true) throw new Error('Workspace plugin registry missing or disabled');
  }
  const metadataScript = "/* WORKSPACE_PACKAGE_METADATA */ console.log(JSON.stringify(process.argv.slice(1).map(name=>{const p=require('/app/nocobase/node_modules/'+name+'/package.json');return {name:p.name,version:p.version}})))";
  let installed;
  try { installed = JSON.parse(String(await exec(['node', '-e', metadataScript, ...local.map(p => p.name)], 30000))); }
  catch { throw new Error('Installed package version metadata invalid'); }
  for (const pkg of local) {
    if (!Array.isArray(installed) || installed.filter(p => p.name === pkg.name && p.version === pkg.version).length !== 1) throw new Error('Installed package version mismatch');
  }
  await waitHealthy();
  return { versions: Object.fromEntries(local.map(p => [p.name, p.version])), backupPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installWorkspace().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
