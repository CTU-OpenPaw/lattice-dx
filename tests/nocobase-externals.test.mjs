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
