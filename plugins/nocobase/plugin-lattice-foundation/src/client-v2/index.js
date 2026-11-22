/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-lattice-foundation/client-v2', ['@nocobase/client', 'react'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'), require('react'));
  }
})(function (client, React) {
  'use strict';
  const actions = require('../client/actions');
  const {createWorkspaceApi} = require('../client/workspace-api');
  class LatticeFoundationClientV2 extends client.Plugin {
    async load() {}
  }
  return {__esModule: true, default: LatticeFoundationClientV2, createWorkspaceApi, ...actions};
});
