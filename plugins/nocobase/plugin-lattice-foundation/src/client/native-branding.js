/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BRAND_FALLBACK_SRC = '/v/lattice-brand.svg';
const SEEDED_DEFAULT_LOGO_SRC = '/files/main/main/attachments/1.png';

function createBrandLogo(client, React) {
  if (typeof client.useSystemSettings !== 'function') return () => null;
  return function BrandLogo({size}) {
    const {data} = client.useSystemSettings() || {};
    const rawSrc = typeof data?.data?.logo?.url === 'string' ? data.data.logo.url.trim() : '';
    const normalizedSrc = (!rawSrc || rawSrc === SEEDED_DEFAULT_LOGO_SRC) ? BRAND_FALLBACK_SRC : rawSrc;
    const [failedSrc, setFailedSrc] = React.useState(null);
    const [fallbackFailed, setFallbackFailed] = React.useState(false);

    const effectiveSrc = failedSrc === normalizedSrc ? BRAND_FALLBACK_SRC : normalizedSrc;
    if (
      typeof effectiveSrc !== 'string'
      || !/^\/(?!\/)[^\\\s]+$/.test(effectiveSrc)
      || (effectiveSrc === BRAND_FALLBACK_SRC && (fallbackFailed || failedSrc === BRAND_FALLBACK_SRC))
    ) {
      return null;
    }

    return React.createElement('img', {
      src: effectiveSrc,
      alt: '',
      width: size,
      height: size,
      onError: () => {
        if (effectiveSrc === BRAND_FALLBACK_SRC) {
          setFallbackFailed(true);
        } else {
          setFailedSrc(normalizedSrc);
        }
      },
      style: {objectFit: 'contain', borderRadius: 6, display: 'block', margin: '0 auto', flexShrink: 0},
    });
  };
}

function registerSignInLogo(app, React, BrandLogo) {
  if (typeof app.router.get !== 'function') return;
  const wrapSignIn = () => {
    const route = app.router.get('auth.signin');
    if (route && route.skipAuthCheck === undefined) {
      route.skipAuthCheck = true;
    }
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
