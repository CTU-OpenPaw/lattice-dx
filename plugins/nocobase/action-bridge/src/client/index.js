/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
define('@latticedx/plugin-action-bridge', ['@nocobase/client'], function (client) {
  class ActionBridgeClient extends client.Plugin {async load() {}}
  return {__esModule: true, default: ActionBridgeClient};
});
