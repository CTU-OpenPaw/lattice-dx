import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWorkspace, parsePluginList } from '../scripts/install-workspace.mjs';

const names = ['@latticedx/plugin-action-bridge', '@latticedx/plugin-lattice-foundation', '@latticedx/plugin-enterprise-auth'];
const versions = await Promise.all(['action-bridge', 'plugin-lattice-foundation', 'plugin-enterprise-auth'].map(async directory =>
  JSON.parse(await readFile(new URL(`../plugins/nocobase/${directory}/package.json`, import.meta.url), 'utf8')).version as string));
async function fixture(options: { dump?: Buffer; backupFailure?: boolean; disabled?: boolean; missing?: boolean; mismatch?: boolean } = {}) {
  const calls: { file: string; args: string[]; options: any }[] = [];
  const backupDir = await mkdtemp(join(tmpdir(), 'workspace-install-'));
  const run = async (file: string, args: string[], opts: any) => {
    calls.push({ file, args, options: opts });
    if (args.includes('pg_dump')) {
      if (options.backupFailure) throw new Error('SECRET DATABASE CREDENTIAL');
      return options.dump ?? Buffer.from('PGDMP-valid-fixture');
    }
    if (args.at(-1) === 'list') return `noise SECRET\n--- BEGIN_PLUGIN_LIST_JSON ---\n${JSON.stringify(options.missing ? [] : names.map((packageName, i) => ({ packageName, enabled: !options.disabled, version: versions[i] })))}\n--- END_PLUGIN_LIST_JSON ---`;
    if (args.some(a => a.includes('WORKSPACE_PACKAGE_METADATA'))) return JSON.stringify(names.map((name, i) => ({ name, version: options.mismatch ? '9.0.0' : versions[i] })));
    return '';
  };
  return { calls, backupDir, invoke: () => installWorkspace({ run, backupDir, health: async () => true }) };
}
describe('workspace installer', () => {
  it('refuses empty or invalid backup before any runtime mutation', async () => {
    for (const dump of [Buffer.alloc(0), Buffer.from('SECRET')]) {
      const f = await fixture({ dump });
      await expect(f.invoke()).rejects.toThrow(/backup/i);
      expect(f.calls.some(c => c.args.includes('up') || c.args.includes('add') || c.args.includes('enable'))).toBe(false);
    }
  });
  it('requires both registered enabled plugins even when commands succeed', async () => {
    for (const options of [{ disabled: true }, { missing: true }]) {
      const f = await fixture(options);
      await expect(f.invoke()).rejects.toThrow(/registry/i);
    }
  });
  it('withholds failed backup output and never recreates the service', async () => {
    const f = await fixture({ backupFailure: true });
    await expect(f.invoke()).rejects.toThrow('Database backup failed; runtime unchanged');
    expect(f.calls.at(-1)?.args).toContain('pg_dump');
    expect(f.calls.some(c => c.file !== 'docker')).toBe(false);
  });
  it('requires installed package versions to match source', async () => {
    const f = await fixture({ mismatch: true });
    await expect(f.invoke()).rejects.toThrow(/version/i);
  });
  it('creates exclusive backup evidence and limits commands to approved services and local packages', async () => {
    const f = await fixture();
    const result = await f.invoke();
    expect(result.versions).toEqual(Object.fromEntries(names.map((name, i) => [name, versions[i]])));
    expect((await readFile(result.backupPath)).subarray(0, 5).toString()).toBe('PGDMP');
    const metadata = JSON.parse(await readFile(result.backupPath + '.json', 'utf8'));
    expect(metadata).toMatchObject({ restoreRehearsed: false, size: 19 });
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const c of f.calls) {
      expect(c.options.timeout).toBeGreaterThan(0);
      expect(c.options.shell).not.toBe(true);
      expect(c.args).not.toEqual(expect.arrayContaining(['down']));
      expect(c.args.join(' ')).not.toMatch(/--volumes|--remove-orphans|\brm\b|password/i);
      if (c.file === 'docker') expect(c.args.slice(0, 5)).toEqual(['--context', 'desktop-linux', 'compose', '-f', 'infra/compose/nocobase.yml']);
    }
    expect(f.calls.find(c => c.args.includes('up'))?.args.slice(-5)).toEqual(['up', '-d', '--no-deps', '--force-recreate', 'nocobase']);
    const packs = f.calls.filter(c => c.args.includes('pack'));
    const restore = f.calls.find(c => c.args.includes('ci'));
    expect(restore?.args).toEqual(expect.arrayContaining(['--prefix', 'plugins/nocobase/plugin-enterprise-auth', '--ignore-scripts']));
    expect(f.calls.indexOf(restore!)).toBeLessThan(f.calls.findIndex(c => c.args.includes('up')));
    expect(packs).toHaveLength(3);
    for (const pack of packs) {
      expect(pack.args).toEqual(expect.arrayContaining(['--offline', '--ignore-scripts', '--pack-destination']));
      expect(pack.options.timeout).toBe(30000);
    }
    expect(f.calls.filter(c => c.args.includes('add'))).toHaveLength(3);
  });
  it('rejects unbounded or malformed plugin JSON', () => {
    expect(() => parsePluginList('SECRET []')).toThrow();
    expect(() => parsePluginList('--- BEGIN_PLUGIN_LIST_JSON ---\n{}\n--- END_PLUGIN_LIST_JSON ---')).toThrow();
    expect(() => parsePluginList('--- BEGIN_PLUGIN_LIST_JSON ---\ninvalid\n--- END_PLUGIN_LIST_JSON ---')).toThrow();
  });
});

