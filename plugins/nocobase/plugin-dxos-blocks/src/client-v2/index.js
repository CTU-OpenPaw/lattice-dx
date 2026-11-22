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
    define('@latticedx/plugin-dxos-blocks/client-v2', ['@nocobase/client'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'));
  }
})(function (client) {
  'use strict';
  class DxosBlocksClientV2 extends client.Plugin {
    async load() {}
  }
  return { __esModule: true, default: DxosBlocksClientV2 };
});
