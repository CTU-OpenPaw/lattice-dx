/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('all 7 NocoBase plugins expose dist/client-v2/index.js using @nocobase/client-v2', () => {
  const plugins = [
    'action-bridge',
    'plugin-dxos-ai',
    'plugin-dxos-blocks',
    'plugin-dxos-para',
    'plugin-dxos-studio',
    'plugin-enterprise-auth',
    'plugin-lattice-foundation',
  ];
  const root = join(process.cwd(), 'plugins/nocobase');
  const legacyClientDepRe = /['"]@nocobase\/client['"]/;
  const v2ClientDepRe = /['"]@nocobase\/client-v2['"]/;

  for (const name of plugins) {
    const dir = join(root, name);
    const wrapperPath = join(dir, 'client-v2.js');
    const srcPath = join(dir, 'src/client-v2/index.js');
    const distPath = join(dir, 'dist/client-v2/index.js');

    assert.ok(existsSync(wrapperPath), `${name}: missing client-v2.js`);
    const wrapper = readFileSync(wrapperPath, 'utf8');
    assert.match(wrapper, /\.\/dist\/client-v2\/index\.js/, `${name}/client-v2.js must point to ./dist/client-v2/index.js`);

    assert.ok(existsSync(srcPath), `${name}: missing src/client-v2/index.js`);
    const src = readFileSync(srcPath, 'utf8');
    assert.match(src, v2ClientDepRe, `${name}/src/client-v2/index.js must depend on @nocobase/client-v2`);
    assert.doesNotMatch(src, legacyClientDepRe, `${name}/src/client-v2/index.js must not depend on @nocobase/client`);

    assert.ok(existsSync(distPath), `${name}: missing dist/client-v2/index.js`);
    const dist = readFileSync(distPath, 'utf8');
    assert.match(dist, v2ClientDepRe, `${name}/dist/client-v2/index.js must depend on @nocobase/client-v2`);
    assert.doesNotMatch(dist, legacyClientDepRe, `${name}/dist/client-v2/index.js must not depend on @nocobase/client`);
  }
});

test('plugin dependency metadata defaults to 2.2.50, supports overrides, and rejects invalid versions', async () => {
  const {
    DEFAULT_NOCOBASE_VERSION,
    externalVersionSource,
    resolveNocoBaseVersion,
  } = await import('../scripts/lib/nocobase-externals.mjs');

  assert.equal(DEFAULT_NOCOBASE_VERSION, '2.2.50');
  assert.equal(resolveNocoBaseVersion({}), '2.2.50');
  assert.equal(resolveNocoBaseVersion({ NOCOBASE_VERSION: ' 2.2.51-rc.1 ' }), '2.2.51-rc.1');
  assert.throws(() => resolveNocoBaseVersion({ NOCOBASE_VERSION: '2.2.50; rm -rf' }), /Invalid NOCOBASE_VERSION/);

  const source = externalVersionSource(['@nocobase/server', '@nocobase/client', 'react']);
  const mod = { exports: {} };
  new Function('module', source)(mod);
  assert.deepEqual(mod.exports, {
    '@nocobase/server': '2.2.50',
    '@nocobase/client': '2.2.50',
    react: '18.2.0',
  });

  const pinnedSource = externalVersionSource(['@nocobase/server', 'antd'], { version: '2.2.38' });
  const mod2 = { exports: {} };
  new Function('module', pinnedSource)(mod2);
  assert.deepEqual(mod2.exports, {
    '@nocobase/server': '2.2.38',
    antd: '5.24.2',
  });

  assert.throws(() => externalVersionSource(['unknown-library']));
  assert.ok(!source.includes('require('), 'metadata must record verified build target, not echo current host');
});
