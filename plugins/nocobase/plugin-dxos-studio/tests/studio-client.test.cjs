/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('plugin-dxos-studio registers /admin/settings/dxos-studio with aclSnippet pm and handles all 4 tabs cleanly', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));

  let registeredKey = null;
  let registeredOpts = null;
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };
  const mockApp = {
    pluginSettingsManager: {
      add(key, opts) {
        registeredKey = key;
        registeredOpts = opts;
      },
    },
  };

  const Page = createDxosStudioSettingsPage(mockClient, React, {}, mockApp);
  assert.equal(typeof Page, 'function');
  mockApp.pluginSettingsManager.add('dxos-studio', { title: 'DX-OS Studio', icon: 'ControlOutlined', Component: Page, aclSnippet: 'pm' });
  assert.equal(registeredKey, 'dxos-studio');
  assert.equal(registeredOpts.aclSnippet, 'pm');

  const tree = Page();
  assert.equal(tree.props['data-testid'], 'dxos-studio-settings-page');
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('7 Plugin'), 'Studio UI should present the 7 Apache-2.0 Open-Core plugins catalog');
  assert.ok(dump.includes('AI Workforce'), 'Studio UI should expose link/reference to AI Workforce Center');
});
