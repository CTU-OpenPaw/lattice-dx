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
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../../..');

function createReactMockWithHooks() {
  const createElementCalls = [];
  const noopHook = (v) => v;
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      createElementCalls.push({ type, props: props || {}, children });
      return { $$typeof: Symbol.for('react.element'), type, props: { ...(props || {}), children } };
    },
    createContext(defaultValue) {
      const ctx = { _currentValue: defaultValue, Provider: 'Context.Provider', Consumer: 'Context.Consumer' };
      return ctx;
    },
    forwardRef(render) {
      return { $$typeof: Symbol.for('react.forward_ref'), render };
    },
    memo(comp) {
      return { $$typeof: Symbol.for('react.memo'), type: comp };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useReducer: (reducer, init) => [init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    useCallback: noopHook,
    useContext: (ctx) => ctx?._currentValue,
    useImperativeHandle: () => {},
    useDebugValue: () => {},
    useSyncExternalStore: (_sub, getSnap) => getSnap(),
    isValidElement: (v) => Boolean(v && typeof v === 'object' && v.type),
    cloneElement: (el, props, ...children) => ({ ...el, props: { ...(el?.props || {}), ...(props || {}) }, children }),
    Children: {
      toArray: (c) => (Array.isArray(c) ? c : c == null ? [] : [c]),
      map: (c, fn) => (Array.isArray(c) ? c.map(fn) : c == null ? [] : [fn(c, 0)]),
    },
  };
  return { React, createElementCalls };
}

test('package.json pins MIT @xyflow/react@12.12.1 and @dagrejs/dagre@3.1.3 in devDependencies only', () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.4.1');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.nocobase?.sdkProvidedByHost, true);
  assert.equal(pkg.nocobase?.testedRuntime, '2.2.50');
  assert.equal(pkg.dependencies, undefined, 'Must NOT declare runtime dependencies on host-isolated plugin');
  assert.equal(pkg.devDependencies?.['@xyflow/react'], '12.12.1');
  assert.equal(pkg.devDependencies?.['@dagrejs/dagre'], '3.1.3');

  const pluginRequire = Module.createRequire(path.join(PLUGIN_ROOT, 'package.json'));
  const xyflowPkg = JSON.parse(readFileSync(pluginRequire.resolve('@xyflow/react/package.json'), 'utf8'));
  const dagrePkg = JSON.parse(readFileSync(pluginRequire.resolve('@dagrejs/dagre/package.json'), 'utf8'));
  assert.equal(xyflowPkg.version, '12.12.1');
  assert.equal(xyflowPkg.license, 'MIT');
  assert.equal(dagrePkg.version, '3.1.3');
  assert.equal(dagrePkg.license, 'MIT');
});

test('nocobase-externals declares react-dom@18.2.0 and dist/externalVersion.js includes it', async () => {
  const { externalVersionSource } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/nocobase-externals.mjs')).href);
  const src = externalVersionSource(['@nocobase/client', 'react', 'react-dom', 'antd']);
  const mod = { exports: {} };
  new Function('module', src)(mod);
  assert.equal(mod.exports['react'], '18.2.0');
  assert.equal(mod.exports['react-dom'], '18.2.0');

  const distExtPath = path.join(PLUGIN_ROOT, 'dist/externalVersion.js');
  assert.ok(existsSync(distExtPath), 'dist/externalVersion.js must exist');
  delete require.cache[require.resolve(distExtPath)];
  const distExt = require(distExtPath);
  assert.equal(distExt['react-dom'], '18.2.0');
  assert.equal(distExt['@nocobase/client-v2'], '2.2.50');
});

test('vendor-shims.js obeys line limit, SPDX header, CSS injection, and Dagre/fallback auto-layout', () => {
  const shimsPath = path.join(PLUGIN_ROOT, 'src/client/flow/vendor-shims.js');
  assert.ok(existsSync(shimsPath), 'src/client/flow/vendor-shims.js must exist');
  const raw = readFileSync(shimsPath, 'utf8');
  const lineCount = raw.split(/\r?\n/).length;
  assert.ok(lineCount <= 120, `vendor-shims.js must be <= 120 lines (got ${lineCount})`);
  assert.ok(raw.includes('SPDX-License-Identifier: Apache-2.0'));

  const shims = require(shimsPath);
  assert.equal(typeof shims.injectFlowStudioCss, 'function');
  assert.equal(typeof shims.injectFlowCss, 'function');
  assert.equal(typeof shims.ensureFlowStudioStyles, 'function');
  assert.equal(typeof shims.getXyflow, 'function');
  assert.equal(typeof shims.getDagre, 'function');
  assert.equal(typeof shims.autoLayoutGraph, 'function');

  // Safe no-op without document
  assert.equal(shims.injectFlowStudioCss(null), false);

  const mockOverride = { ReactFlow: function MockRF() {} };
  assert.equal(shims.getXyflow(mockOverride), mockOverride);

  const sampleGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.event', position: { x: 0, y: 0 } },
      { id: 'if1', type: 'control.if', position: { x: 0, y: 0 } },
      { id: 'a1', type: 'notify.send', position: { x: 0, y: 0 } },
      { id: 'a2', type: 'data.create', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 't1', sourceHandle: 'main', target: 'if1' },
      { id: 'e2', source: 'if1', sourceHandle: 'true', target: 'a1' },
      { id: 'e3', source: 'if1', sourceHandle: 'false', target: 'a2' },
    ],
  };

  // Test with Dagre (if resolved) and explicit topological fallback (dagreOverride: false)
  for (const dagreOverride of [undefined, false]) {
    const laidOut = shims.autoLayoutGraph(sampleGraph, { direction: 'LR', dagreOverride });
    assert.equal(laidOut.nodes.length, 4);
    const byId = Object.fromEntries(laidOut.nodes.map((n) => [n.id, n]));
    assert.ok(byId.t1.position.x < byId.if1.position.x, 'trigger must precede condition in LR');
    assert.ok(byId.if1.position.x < byId.a1.position.x, 'condition must precede branch a1 in LR');
    assert.ok(byId.if1.position.x < byId.a2.position.x, 'condition must precede branch a2 in LR');
    assert.notEqual(byId.a1.position.y, byId.a2.position.y, 'parallel branches must separate vertically');
  }
});

test('dist/client/index.js passes node --check, bundles @xyflow/react + @dagrejs/dagre + css, and excludes React/ReactDOM internals', () => {
  const distClientPath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  assert.ok(existsSync(distClientPath), 'dist/client/index.js must exist');
  const syntax = spawnSync(process.execPath, ['--check', distClientPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `node --check failed: ${syntax.stderr}`);

  const bundleSrc = readFileSync(distClientPath, 'utf8');
  assert.match(
    bundleSrc,
    /define\(\s*['"]@latticedx\/plugin-dxos-studio['"]\s*,\s*\[\s*['"]@nocobase\/client['"]\s*,\s*['"]react['"]\s*,\s*['"]antd['"]\s*\]/,
  );

  // Zero bundled React or ReactDOM runtime
  assert.equal(bundleSrc.includes('SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED'), false, 'Must NOT bundle React internals');
  assert.doesNotMatch(bundleSrc, /react\/cjs\/react\.(?:production|development)/);
  assert.doesNotMatch(bundleSrc, /react-dom\/cjs\/react-dom\.(?:production|development)/);

  // Bundled MIT graph libraries & XYFlow CSS id/classes
  assert.match(bundleSrc, /dxos-xyflow-css/);
  assert.match(bundleSrc, /\.react-flow/);
  assert.match(bundleSrc, /ReactFlow/);
  assert.match(bundleSrc, /dagre|graphlib/i);

  // dist/client-v2/index.js remains isolated on @nocobase/client-v2
  const distV2 = readFileSync(path.join(PLUGIN_ROOT, 'dist/client-v2/index.js'), 'utf8');
  assert.match(distV2, /['"]@nocobase\/client-v2['"]/);
  assert.doesNotMatch(distV2, /['"]@nocobase\/client['"]/);
});

test('dist/client/index.js loads cleanly via CJS without react-dom installed AND via AMD define() with single host React dispatcher', async () => {
  const distClientPath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  const { React: mockReact, createElementCalls } = createReactMockWithHooks();
  class MockPlugin {
    constructor(app) { this.app = app; }
  }
  const mockClient = {
    Plugin: MockPlugin,
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };

  // 1. CJS load with react-dom deliberately unavailable in Module._load
  const origLoad = Module._load;
  Module._load = function mockedHost(request, parent, isMain) {
    if (request === '@nocobase/client') return mockClient;
    if (request === 'react') return mockReact;
    if (request === 'antd') return {};
    if (request === 'react-dom' || request === 'react-dom/client') {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  let loadedMod;
  try {
    delete require.cache[require.resolve(distClientPath)];
    loadedMod = require(distClientPath);
  } finally {
    Module._load = origLoad;
  }

  assert.equal(loadedMod.__esModule, true);
  assert.equal(typeof loadedMod.default, 'function');
  assert.equal(typeof loadedMod.createPublicFormBuilderPanel, 'function');
  assert.equal(typeof loadedMod.PublicFormBuilderPanel, 'function');
  assert.equal(typeof loadedMod.createApprovalInboxPanel, 'function');
  assert.equal(typeof loadedMod.ApprovalInboxPanel, 'function');
  const registered = {};
  const routerAdded = {};
  const pluginInstance = new loadedMod.default({
    pluginSettingsManager: {
      add(name, opts) { registered[name] = opts; },
    },
    router: {
      add(name, opts) { routerAdded[name] = opts; },
    },
  });
  await pluginInstance.load();
  assert.equal(registered['dxos-flow-studio']?.hidden, true, 'Legacy dxos-flow-studio entry must be hidden from sidebar');
  assert.equal(registered['dxos-flow-studio']?.link, '/admin/settings/workflow/automation');
  assert.equal(registered['dxos-flow-studio']?.aclSnippet, 'pm');
  assert.equal(typeof registered['workflow.automation']?.Component, 'function');
  assert.equal(registered['workflow.automation']?.title, 'Workflow Automation');
  assert.equal(registered['workflow.automation']?.icon, 'ApartmentOutlined');
  assert.equal(registered['workflow.automation']?.aclSnippet, 'pm');
  assert.equal(registered['workflow.automation']?.sort, 20);
  assert.equal(registered['dxos-flow-studio']?.Component, registered['workflow.automation'].Component);
  assert.equal(typeof registered['dxos-studio']?.Component, 'function');
  assert.equal(registered['dxos-studio']?.aclSnippet, 'pm');

  // Verify bundled vendorShims exposes real bundled @xyflow/react + @dagrejs/dagre + CSS injection
  const shims = loadedMod.__dxosVendorShims;
  assert.ok(shims, 'Compiled bundle must retain vendor shims');
  const xyflow = shims.getXyflow();
  assert.ok(xyflow && (xyflow.ReactFlow || xyflow.default), 'Bundled @xyflow/react must be available');
  assert.ok(shims.getDagre(), 'Bundled @dagrejs/dagre must be available');

  // Verify idempotent <style id="dxos-xyflow-css"> injection
  const appended = [];
  const byId = new Map();
  const mockDoc = {
    head: {
      appendChild(el) {
        appended.push(el);
        if (el.id) byId.set(el.id, el);
      },
    },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return { tag, id: '', textContent: '', setAttribute() {} }; },
  };
  assert.equal(shims.injectFlowStudioCss(mockDoc), true);
  assert.equal(shims.injectFlowStudioCss(mockDoc), true);
  assert.equal(appended.length, 1, 'Style tag injection must be idempotent');
  assert.equal(appended[0].id, 'dxos-xyflow-css');
  assert.ok(appended[0].textContent.includes('.react-flow'));

  // Verify bundled @xyflow/react JSX uses host React.createElement (zero duplicated React dispatcher)
  const beforeCount = createElementCalls.length;
  const baseEdgeFn = xyflow.BaseEdge;
  assert.equal(typeof baseEdgeFn, 'function', 'Bundled @xyflow/react must export BaseEdge');
  const renderedEdge = baseEdgeFn({ id: 'e1', path: 'M0,0 L10,10' });
  assert.ok(renderedEdge && renderedEdge.type, 'BaseEdge must return React element from host React');
  assert.ok(createElementCalls.length > beforeCount, 'Host React.createElement must handle bundled XYFlow JSX');

  const layoutOut = shims.autoLayoutGraph({
    version: 2,
    nodes: [{ id: 'n1', position: { x: 0, y: 0 } }, { id: 'n2', position: { x: 0, y: 0 } }],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  });
  assert.ok(layoutOut.nodes[0].position.x < layoutOut.nodes[1].position.x, 'Bundled Dagre LR must position n1 left of n2');

  // 2. AMD RequireJS browser mode (no `module`, `define.amd = true`)
  const bundleCode = readFileSync(distClientPath, 'utf8');
  let amdDef = null;
  const mockDefine = Object.assign(
    (id, deps, factory) => { amdDef = { id, deps, factory }; },
    { amd: true },
  );
  const runAmd = new Function('define', 'window', 'requirejs', bundleCode);
  runAmd(mockDefine, { ReactDOM: undefined }, undefined);
  assert.equal(amdDef?.id, '@latticedx/plugin-dxos-studio');
  assert.deepEqual(amdDef?.deps, ['@nocobase/client', 'react', 'antd']);
  const amdExports = amdDef.factory(mockClient, mockReact, {});
  assert.equal(amdExports.__esModule, true);
  assert.equal(typeof amdExports.default, 'function');
  assert.equal(typeof amdExports.createPublicFormBuilderPanel, 'function');
  assert.equal(typeof amdExports.createApprovalInboxPanel, 'function');
  assert.ok(amdExports.__dxosVendorShims.getXyflow()?.ReactFlow, 'AMD factory must also retain bundled @xyflow/react');
});

test('dist/client/index.js resolves host ReactDOM lazily per call and returns null from EdgeLabelRenderer when unavailable', () => {
  const distClientPath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  const bundleCode = readFileSync(distClientPath, 'utf8');
  const { React: portalReact } = createReactMockWithHooks();
  const portalTarget = { nodeType: 1, className: 'react-flow__edgelabel-renderer' };
  portalReact.useContext = () => ({
    getState: () => ({ domNode: { querySelector: (sel) => (sel === '.react-flow__edgelabel-renderer' ? portalTarget : null) } }),
    subscribe: () => () => {},
  });

  let amdDef = null;
  const mockDefine = Object.assign((id, deps, factory) => { amdDef = { id, deps, factory }; }, { amd: true });
  const mockWindow = { ReactDOM: undefined };
  let rjsLoaded = false;
  const mockRequirejs = Object.assign(
    (id) => {
      if (id === 'react-dom' && rjsLoaded) {
        return { createPortal: (children, target) => ({ $$portal: 'requirejs', children, target }) };
      }
      throw new Error(`Module not loaded: ${id}`);
    },
    { defined: (id) => id === 'react-dom' && rjsLoaded },
  );
  const lateClient = { Plugin: class {}, useAPIClient: () => ({ request: async () => ({}) }), ReactDOM: undefined };
  const origGlobalReactDom = globalThis.ReactDOM;

  try {
    delete globalThis.ReactDOM;
    new Function('define', 'window', 'requirejs', bundleCode)(mockDefine, mockWindow, mockRequirejs);
    const exportsObj = amdDef.factory(lateClient, portalReact, {});
    const { EdgeLabelRenderer } = exportsObj.__dxosVendorShims.getXyflow();
    const labelEl = portalReact.createElement('div', null, '+');

    assert.equal(EdgeLabelRenderer({ children: labelEl }), null, 'Missing host ReactDOM must return null rather than leaking raw div into SVG');

    rjsLoaded = true;
    const rjsPortal = EdgeLabelRenderer({ children: labelEl });
    assert.equal(rjsPortal?.$$portal, 'requirejs');
    assert.equal(rjsPortal?.children, labelEl);
    assert.equal(rjsPortal?.target, portalTarget);

    rjsLoaded = false;
    lateClient.ReactDOM = { createPortal: (children, target) => ({ $$portal: 'client', children, target }) };
    assert.equal(EdgeLabelRenderer({ children: labelEl })?.$$portal, 'client');

    lateClient.ReactDOM = undefined;
    mockWindow.ReactDOM = { createPortal: (children, target) => ({ $$portal: 'window', children, target }) };
    const winPortal = EdgeLabelRenderer({ children: labelEl });
    assert.equal(winPortal?.$$portal, 'window');
    assert.equal(winPortal?.target, portalTarget);

    mockWindow.ReactDOM = undefined;
    assert.equal(EdgeLabelRenderer({ children: labelEl }), null);
  } finally {
    if (origGlobalReactDom === undefined) delete globalThis.ReactDOM;
    else globalThis.ReactDOM = origGlobalReactDom;
  }
});
