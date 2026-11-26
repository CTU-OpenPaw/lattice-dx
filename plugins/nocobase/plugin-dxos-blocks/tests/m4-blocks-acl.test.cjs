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
const Module = require('node:module');
const path = require('node:path');

test('DxosBlocksServerPlugin registers dxosBlocks:decideProposal in app.acl.allow for loggedIn', async () => {
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app, options) {
      this.app = app;
      this.options = options;
      this.db = app?.db;
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Plugin: MockPlugin };
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const serverIndexPath = path.resolve(__dirname, '../src/server/index.js');
    delete require.cache[require.resolve(serverIndexPath)];
    const DxosBlocksServerPlugin = require(serverIndexPath);

    const definedResources = [];
    const aclAllowCalls = [];
    const mockApp = {
      db: {
        getRepository: () => null,
      },
      resourceManager: {
        use: () => {},
        define: (def) => { definedResources.push(def); },
      },
      acl: {
        allow: (resource, actions, condition) => {
          aclAllowCalls.push({ resource, actions, condition });
        },
      },
    };

    const plugin = new DxosBlocksServerPlugin(mockApp, {});
    await plugin.load();

    const dxosBlocksResource = definedResources.find((r) => r.name === 'dxosBlocks');
    assert.ok(dxosBlocksResource, 'dxosBlocks resource must be defined');
    assert.equal(typeof dxosBlocksResource.actions?.decideProposal, 'function', 'dxosBlocks.actions.decideProposal must exist');

    const loggedInRule = aclAllowCalls.find(
      (c) => c.resource === 'dxosBlocks' && c.condition === 'loggedIn',
    );
    assert.ok(loggedInRule, 'Expected app.acl.allow rule for dxosBlocks loggedIn');
    assert.ok(
      Array.isArray(loggedInRule.actions) && loggedInRule.actions.includes('decideProposal'),
      `Expected decideProposal in dxosBlocks loggedIn ACL actions, got: ${JSON.stringify(loggedInRule.actions)}`,
    );
  } finally {
    Module._load = origLoad;
  }
});
