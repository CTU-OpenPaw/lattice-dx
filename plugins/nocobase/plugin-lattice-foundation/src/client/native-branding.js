/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createBrandLogo(client, React) {
  if (typeof client.useSystemSettings !== 'function') return () => null;
  return function BrandLogo({size}) {
    const {data} = client.useSystemSettings() || {};
    const src = data?.data?.logo?.url;
    const [failedSrc, setFailedSrc] = React.useState(null);
    if (typeof src !== 'string' || !/^\/(?!\/)[^\\\s]+$/.test(src) || failedSrc === src) return null;
    return React.createElement('img', {
      src,
      alt: '',
      width: size,
      height: size,
      onError: () => setFailedSrc(src),
      style: {objectFit: 'contain', borderRadius: 6, display: 'block', margin: '0 auto', flexShrink: 0},
    });
  };
}

function registerSignInLogo(app, React, BrandLogo) {
  if (typeof app.router.get !== 'function') return;
  const wrapSignIn = () => {
    const route = app.router.get('auth.signin');
    const withLogo = NativeSignIn => function BrandedSignIn(props) {
      const form = typeof NativeSignIn === 'string'
        ? app.renderComponent(NativeSignIn, props)
        : React.createElement(NativeSignIn, props);
      return React.createElement(React.Fragment, null,
        React.createElement(BrandLogo, {size: 72}),
        form);
    };
    if (typeof route?.componentLoader === 'function') {
      const loadNativeSignIn = route.componentLoader;
      route.componentLoader = async () => {
        const loaded = await loadNativeSignIn();
        return withLogo(loaded.default ?? loaded.Component ?? loaded);
      };
      return true;
    }
    if (route?.Component) {
      route.Component = withLogo(route.Component);
      return true;
    }
    return false;
  };
  if (wrapSignIn() || !app.eventBus) return;
  const events = ['plugin:auth:loaded', 'plugin:@nocobase/plugin-auth:loaded'];
  const onAuthLoaded = () => {
    if (wrapSignIn()) for (const name of events) app.eventBus.removeEventListener(name, onAuthLoaded);
  };
  for (const name of events) app.eventBus.addEventListener(name, onAuthLoaded);
}

module.exports = {createBrandLogo, registerSignInLogo};
