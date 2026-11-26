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
    define('@latticedx/plugin-lattice-foundation/client-v2', ['@nocobase/client-v2', 'react'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client-v2'), require('react'));
  }
})(function (client, React) {
  'use strict';
  const actions = require('../client/actions');
  const {createWorkspaceApi} = require('../client/workspace-api');
  const mobileFieldPwa = require('./mobile-field-pwa');
  const {createMobileFieldPwaPage} = mobileFieldPwa;
  const publicTrack = require('./public-track-page');
  const {createPublicTrackPage} = publicTrack;
  const publicForm = require('./public-form-page');
  const {createPublicFormPage} = publicForm;
  class LatticeFoundationClientV2 extends client.Plugin {
    async load() {
      const MobileFieldPwaPage = createMobileFieldPwaPage(client, React, this.app);
      const PublicTrackPage = createPublicTrackPage(client, React, this.app);
      const PublicFormPage = createPublicFormPage(client, React, this.app);
      if (this.app?.router && typeof this.app.router.add === 'function') {
        this.app.router.add('dxos-mobile-field', { path: '/mobile', Component: MobileFieldPwaPage });
        this.app.router.add('dxos-mobile-field-sub', { path: '/mobile/*', Component: MobileFieldPwaPage });
        this.app.router.add('dxos-public-track', { path: '/track/:code', Component: PublicTrackPage, skipAuthCheck: true });
        this.app.router.add('dxos-public-track-root', { path: '/track', Component: PublicTrackPage, skipAuthCheck: true });
        this.app.router.add('dxos-public-form', { path: '/form/:slug', Component: PublicFormPage, skipAuthCheck: true });
        this.app.router.add('dxos-public-form-root', { path: '/form', Component: PublicFormPage, skipAuthCheck: true });
      }
    }
  }
  return {__esModule: true, default: LatticeFoundationClientV2, createWorkspaceApi, ...actions, ...mobileFieldPwa, ...publicTrack, ...publicForm};
});
