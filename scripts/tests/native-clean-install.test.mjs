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
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  cleanInstallPlan,
  nativeCleanInstall,
  parseCleanInstallArgs,
} from '../native-clean-install.mjs';

function createCleanInstallMockRun({ precreateNodeModules = false } = {}) {
  const calls = [];
  const directories = [
    'action-bridge',
    'plugin-lattice-foundation',
    'plugin-enterprise-auth',
    'plugin-dxos-para',
    'plugin-dxos-blocks',
    'plugin-dxos-studio',
    'plugin-dxos-ai',
  ];
  const names = [
    '@latticedx/plugin-action-bridge',
    '@latticedx/plugin-lattice-foundation',
    '@latticedx/plugin-enterprise-auth',
    '@latticedx/plugin-dxos-para',
    '@latticedx/plugin-dxos-blocks',
    '@latticedx/plugin-dxos-studio',
    '@latticedx/plugin-dxos-ai',
  ];
  const migrations = [
    { pkg: '@latticedx/plugin-lattice-foundation', dir: 'plugin-lattice-foundation', name: '20261107000100-shared-upload-receipts/@latticedx/plugin-lattice-foundation' },
    { pkg: '@latticedx/plugin-dxos-para', dir: 'plugin-dxos-para', name: '20261120000100-dxos-para-init/@latticedx/plugin-dxos-para' },
    { pkg: '@latticedx/plugin-dxos-blocks', dir: 'plugin-dxos-blocks', name: '20261123000500-dxos-telemetry-timeseries/@latticedx/plugin-dxos-blocks' },
    { pkg: '@latticedx/plugin-dxos-studio', dir: 'plugin-dxos-studio', name: '20261120000200-dxos-service-tickets/@latticedx/plugin-dxos-studio' },
    { pkg: '@latticedx/plugin-dxos-ai', dir: 'plugin-dxos-ai', name: '20261121000100-dxos-ai-workforce/@latticedx/plugin-dxos-ai' },
  ];

  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'git' && args[0] === 'rev-parse') return 'a'.repeat(40);
    if (file === 'tar') {
      const target = args.at(-1);
      for (let i = 0; i < names.length; i += 1) {
        const directory = join(target, 'plugins/nocobase', directories[i]);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name: names[i], version: '0.4.2', license: 'Apache-2.0' }));
      }
      for (const m of migrations) {
        const directory = join(target, 'plugins/nocobase', m.dir, 'src/server/migrations');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${m.name.split('/')[0]}.js`), '');
      }
      if (precreateNodeModules) {
        await mkdir(join(target, 'node_modules'), { recursive: true });
      }
    }
    if (args.includes('install') && args.includes('--offline')) {
      await mkdir(join(options.cwd, 'node_modules'), { recursive: true });
    }
    if (args.includes('psql')) {
      return args.at(-1)?.includes('pg_tables') ? '0' : JSON.stringify(migrations.map((m) => m.name));
    }
    if (args.includes('pg_dump')) return Buffer.from('PGDMP-test-fixture');
    if (args.at(-1) === 'list') {
      return `--- BEGIN_PLUGIN_LIST_JSON ---\n${JSON.stringify(names.map((packageName) => ({ packageName, enabled: true })))}\n--- END_PLUGIN_LIST_JSON ---`;
    }
    if (args.some((arg) => arg.includes('WORKSPACE_PACKAGE_METADATA'))) {
      return JSON.stringify(names.map((name) => ({ name, version: '0.4.2' })));
    }
    if (args.some((arg) => arg.includes("require('@nocobase/server/package.json')"))) {
      return '2.2.50';
    }
    if (file === process.execPath && args[0]?.includes('acceptance-native-')) {
      return JSON.stringify({ result: 'PASS', checks: ['test-fixture'] });
    }
    if (file === process.execPath && args[0] === 'scripts/setup-native-ui-lab.mjs') {
      const directory = join(options.cwd, 'output/native-platform');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'ui-lab.json'),
        JSON.stringify({ path: '/admin/fixture', accounts: [{ email: 'fixture@example.invalid', role: 'ldx_employee' }] }),
      );
    }
    return '';
  };

  return { calls, run };
}

function isOfflinePnpmInstallCall(call) {
  return (
    Array.isArray(call.args)
    && call.args.includes('install')
    && call.args.includes('--offline')
    && call.args.includes('--frozen-lockfile')
    && call.args.includes('--ignore-scripts')
  );
}

test('Bug #1 regression: nativeCleanInstall installs offline node_modules in exported source even when blankSlate is false', async () => {
  const { calls, run } = createCleanInstallMockRun({ precreateNodeModules: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  let reportPath = null;
  try {
    const result = await nativeCleanInstall({ run, port: 13014, blankSlate: false });
    reportPath = result.reportPath;
    assert.equal(result.complete, true);
    assert.equal(result.blankSlate, false);
    assert.equal(existsSync(join(result.sourceRoot, 'node_modules')), true);

    const pnpmIdx = calls.findIndex(isOfflinePnpmInstallCall);
    const buildIdx = calls.findIndex((call) => call.file === process.execPath && String(call.args?.[0] || '').endsWith('build.mjs'));
    assert.ok(pnpmIdx >= 0, 'Expected offline pnpm install in sourceRoot when blankSlate=false');
    assert.ok(buildIdx > pnpmIdx, 'Expected offline pnpm install before plugin build.mjs execution');
    assert.equal(calls[pnpmIdx].options?.cwd, result.sourceRoot);
  } finally {
    globalThis.fetch = originalFetch;
    if (reportPath) {
      await rm(dirname(reportPath), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('nativeCleanInstall skips offline pnpm install when sourceRoot/node_modules already exists', async () => {
  const { calls, run } = createCleanInstallMockRun({ precreateNodeModules: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  let reportPath = null;
  try {
    const result = await nativeCleanInstall({ run, port: 13015, blankSlate: false });
    reportPath = result.reportPath;
    assert.equal(result.complete, true);
    assert.equal(calls.some(isOfflinePnpmInstallCall), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (reportPath) {
      await rm(dirname(reportPath), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('parseCleanInstallArgs and cleanInstallPlan handle --blank-slate and --keep cleanly', () => {
  assert.deepEqual(parseCleanInstallArgs(['--port=13014', '--blank-slate', '--keep']), {
    port: 13014,
    blankSlate: true,
    keep: true,
  });
  const plan = cleanInstallPlan('abcdef123456', 13014, { blankSlate: true });
  assert.match(plan.overlay, /LATTICE_SKIP_DEMO_SEED: "1"/);
  assert.match(plan.overlay, /127\.0\.0\.1:13014:80/);
});
