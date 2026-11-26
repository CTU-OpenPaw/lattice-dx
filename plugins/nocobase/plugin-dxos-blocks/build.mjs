/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { externalVersionSource } from '../../../scripts/lib/nocobase-externals.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const pluginRequire = createRequire(join(root, 'package.json'));

async function checkDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await checkDir(full);
    else if (entry.name.endsWith('.js')) {
      const res = spawnSync(process.execPath, ['--check', full], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`Invalid JavaScript: ${full}`);
    }
  }
}

const HOST_EXTERNAL_MAP = {
  react: 'module.exports = __dxosHostExternals.react;',
  antd: 'module.exports = __dxosHostExternals.antd;',
  '@nocobase/client': 'module.exports = __dxosHostExternals.client;',
  '@nocobase/client-v2': 'module.exports = __dxosHostExternals.clientV2;',
  'react-dom': 'module.exports = __dxosHostExternals.reactDom;',
  'react-dom/client': 'module.exports = __dxosHostExternals.reactDomClient;',
  'react/jsx-runtime': 'module.exports = __dxosHostExternals.jsxRuntime;',
  'react/jsx-dev-runtime': 'module.exports = __dxosHostExternals.jsxRuntime;',
};

function createDxosBlocksEsbuildPlugin() {
  return {
    name: 'dxos-blocks-host-externals-and-maplibre',
    setup(build) {
      build.onResolve(
        { filter: /^(?:react|react-dom(?:\/client)?|react\/jsx(?:-dev)?-runtime|antd|@nocobase\/client(?:-v2)?)$/ },
        (args) => ({ path: args.path, namespace: 'dxos-host-external' }),
      );
      build.onLoad({ filter: /.*/, namespace: 'dxos-host-external' }, (args) => ({
        contents: HOST_EXTERNAL_MAP[args.path],
        loader: 'js',
      }));

      build.onResolve({ filter: /^maplibre-gl$/ }, () => ({
        path: pluginRequire.resolve('maplibre-gl/dist/maplibre-gl.mjs'),
      }));

      build.onResolve({ filter: /^maplibre-gl\/dist\/maplibre-gl\.css$/ }, (args) => ({
        path: pluginRequire.resolve(args.path),
        namespace: 'dxos-css-text',
      }));
      build.onLoad({ filter: /.*/, namespace: 'dxos-css-text' }, async (args) => ({
        contents: `module.exports = ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
        loader: 'js',
      }));

      build.onResolve({ filter: /^maplibre-gl\/dist\/maplibre-gl-worker\.mjs$/ }, (args) => ({
        path: 'dxos-maplibre-worker.js',
        namespace: 'dxos-worker-text',
        pluginData: { filePath: pluginRequire.resolve(args.path) },
      }));
      build.onLoad({ filter: /.*/, namespace: 'dxos-worker-text' }, async (args) => {
        const builtWorker = await esbuild.build({
          entryPoints: [args.pluginData.filePath],
          bundle: true,
          write: false,
          format: 'iife',
          platform: 'browser',
          target: ['es2020'],
          minify: true,
        });
        const workerCode = builtWorker.outputFiles?.[0]?.text || '';
        return {
          contents: `module.exports = ${JSON.stringify(workerCode)};`,
          loader: 'js',
        };
      });
    },
  };
}

function wrapUmdClientBundle(cjsBundleCode) {
  const header = `/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-dxos-blocks', ['@nocobase/client', 'react', 'antd', '@nocobase/client-v2'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('@nocobase/client'),
      require('react'),
      require('antd'),
      require('@nocobase/client-v2'),
    );
  } else {
    root.DxosBlocksPlugin = factory(root.NocoBaseClient || {}, root.React, root.antd, root.NocoBaseClientV2 || {});
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (client, React, antd, clientV2) {
  'use strict';
  var __cjsRequire = typeof require === 'function' ? require : null;
  function hostReactDom(requiredMethod) {
    var hasMethod = function (candidate) {
      return Boolean(candidate && (!requiredMethod || typeof candidate[requiredMethod] === 'function'));
    };
    if (typeof window !== 'undefined' && hasMethod(window.ReactDOM)) return window.ReactDOM;
    if (typeof globalThis !== 'undefined' && hasMethod(globalThis.ReactDOM)) return globalThis.ReactDOM;
    if (client && hasMethod(client.ReactDOM)) return client.ReactDOM;
    if (typeof requirejs === 'function' && typeof requirejs.defined === 'function' && requirejs.defined('react-dom')) {
      try {
        var rjsDom = requirejs('react-dom');
        if (hasMethod(rjsDom)) return rjsDom;
      } catch {}
    }
    if (__cjsRequire) {
      try {
        var cjsDom = __cjsRequire('react-dom');
        if (hasMethod(cjsDom)) return cjsDom;
      } catch {}
    }
    return null;
  }
  var __safeReactDom = {
    createPortal: function () {
      var dom = hostReactDom('createPortal');
      return dom ? dom.createPortal.apply(dom, arguments) : null;
    },
    flushSync: function (fn) {
      var dom = hostReactDom('flushSync');
      if (dom) return dom.flushSync.apply(dom, arguments);
      return typeof fn === 'function' ? fn() : undefined;
    },
    unstable_batchedUpdates: function (fn, arg) {
      var dom = hostReactDom('unstable_batchedUpdates');
      if (dom) return dom.unstable_batchedUpdates.apply(dom, arguments);
      return typeof fn === 'function' ? (arguments.length > 1 ? fn(arg) : fn()) : undefined;
    },
  };
  var __safeReactDomClient = {
    createRoot: function () {
      var dom = hostReactDom('createRoot');
      if (dom) return dom.createRoot.apply(dom, arguments);
      throw new Error('react-dom/client createRoot unavailable');
    },
    hydrateRoot: function () {
      var dom = hostReactDom('hydrateRoot');
      if (dom) return dom.hydrateRoot.apply(dom, arguments);
      throw new Error('react-dom/client hydrateRoot unavailable');
    },
  };
  function __makeHostJsx(isStatic) {
    return function hostJsx(type, config, maybeKey) {
      var props = {};
      var key = maybeKey !== undefined ? '' + maybeKey : null;
      var hasChildren = false;
      var children;
      if (config && typeof config === 'object') {
        if (config.key !== undefined) key = '' + config.key;
        for (var propName in config) {
          if (Object.prototype.hasOwnProperty.call(config, propName) && propName !== 'key' && propName !== '__self' && propName !== '__source') {
            if (propName === 'children') { hasChildren = true; children = config.children; }
            else { props[propName] = config[propName]; }
          }
        }
      }
      if (key !== null) props.key = key;
      if (!hasChildren) return React.createElement(type, props);
      if (isStatic && Array.isArray(children)) {
        return React.createElement.apply(React, [type, props].concat(children));
      }
      return React.createElement(type, props, children);
    };
  }
  var __dxosHostExternals = {
    client: client,
    react: React,
    antd: antd,
    clientV2: clientV2,
    reactDom: __safeReactDom,
    reactDomClient: __safeReactDomClient,
    jsxRuntime: {
      Fragment: React.Fragment,
      jsx: __makeHostJsx(false),
      jsxs: __makeHostJsx(true),
      jsxDEV: __makeHostJsx(false),
    },
  };
  return (function () {
    var define = undefined;
    var module = { exports: {} };
    var exports = module.exports;
`;
  const footer = `
    return module.exports;
  })();
});
`;
  return `${header}${cjsBundleCode}${footer}`;
}

await checkDir(join(root, 'src'));
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist'), { recursive: true });
await cp(join(root, 'src'), join(root, 'dist'), { recursive: true });
await writeFile(
  join(root, 'dist/externalVersion.js'),
  externalVersionSource(['@nocobase/server', '@nocobase/database', '@nocobase/client', '@nocobase/client-v2', 'react', 'react-dom', 'antd']),
  'utf8',
);

const virtualEntry = [
  "const __dxosMapLibre = require('maplibre-gl');",
  "const __dxosMapLibreCss = require('maplibre-gl/dist/maplibre-gl.css');",
  "const __dxosMapLibreWorker = require('maplibre-gl/dist/maplibre-gl-worker.mjs');",
  "if (typeof globalThis !== 'undefined') {",
  "  globalThis.__DXOS_MAPLIBRE_BUNDLE__ = { maplibre: __dxosMapLibre, cssText: __dxosMapLibreCss, workerText: __dxosMapLibreWorker };",
  "}",
  "module.exports = require('./src/client/index.js');",
].join('\n');

const bundled = await esbuild.build({
  stdin: {
    contents: virtualEntry,
    resolveDir: root,
    sourcefile: 'dxos-blocks-client-entry.js',
    loader: 'js',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  keepNames: true,
  treeShaking: true,
  define: {
    __DXOS_BUNDLED__: 'true',
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': '""',
  },
  plugins: [createDxosBlocksEsbuildPlugin()],
});

if (bundled.errors?.length) {
  throw new Error(`esbuild failed: ${bundled.errors.map((e) => e.text).join('; ')}`);
}
const clientEntry = join(root, 'dist/client/index.js');
await writeFile(clientEntry, wrapUmdClientBundle(bundled.outputFiles[0].text), 'utf8');

const syntaxCheck = spawnSync(process.execPath, ['--check', clientEntry], { stdio: 'inherit' });
if (syntaxCheck.status !== 0) throw new Error(`Invalid bundled client: ${clientEntry}`);

console.log('Built @latticedx/plugin-dxos-blocks (server + esbuild UMD client + client-v2 entrypoints).');
